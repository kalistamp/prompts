/* ============================================================
   PROMPT STUDIO CLOUD — persistence layer

   Everything here is data plumbing and auth. No DOM, no rendering —
   script.js owns the UI state and calls in, and re-renders when the
   onChange callback fires.

   SHAPE
     prompt_items   one row per prompt, in one of three sections
     prompt_runs    one row per API run — append-only, online-only
     user_settings  one jsonb row: retention windows, defaults

   TWO SYNC TIERS, ON PURPOSE
     Prompts use the delta/revision machinery this schema has always
     had: an IndexedDB outbox so the UI never blocks on the network, a
     revision cursor so a pull is a delta rather than a table scan, and
     optimistic concurrency on each row so two devices editing
     different prompts never fight.

     Runs do NOT. You cannot make an API call offline, so a run has
     nothing to queue — it is written once when the call resolves or
     throws, then only `keep` is toggled and rows are deleted. They are
     cached in IndexedDB for offline READING only.

   CONFLICT MODEL
     Per row, via `expected_revision`. A row that moved underneath us
     raises PROMPT_VERSION_CONFLICT; we force a full pull, rebase the
     pending mutations onto the revisions that came back, and retry —
     with a bounded number of attempts and a backoff, so a conflict
     that cannot be resolved stops instead of hammering the RPC.
   ============================================================ */

(function () {
  'use strict';

  const LOCAL_DB_NAME = 'prompt-studio';
  const LOCAL_DB_VERSION = 2;
  const DELTA_PAGE_SIZE = 500;
  const RUNS_PAGE_SIZE = 500;

  const PROMPT_COLUMNS = [
    'id', 'title', 'prompt_text', 'category', 'tags', 'notes', 'pinned',
    'created_at', 'updated_at', 'sort_order', 'deleted_at', 'revision',
    'section', 'expires_at', 'run_config'
  ].join(',');

  const RUN_COLUMNS = [
    'id', 'meta_prompt_id', 'meta_prompt_title', 'provider', 'requested_model',
    'served_model', 'response_id', 'prompt_version', 'input', 'output', 'status',
    'error_message', 'input_tokens', 'output_tokens', 'cost_usd', 'duration_ms',
    'keep', 'saved_prompt_id', 'created_at'
  ].join(',');

  const SECTIONS = ['library', 'workshop', 'scratch'];

  // Mirrors the CHECK constraint on prompt_items.section. A value no
  // list here recognises would be rejected by Postgres outright, so
  // the row is repaired on the way out rather than failing the batch.
  function safeSection(value) {
    return SECTIONS.includes(value) ? value : 'library';
  }

  /* Number(null), Number('') and Number([]) are all 0, and
     Number.isFinite(0) is true — so Number.isFinite(Number(v)) waves
     nulls straight through as zero. Reject non-numeric input before
     coercing, or a null id becomes a real row with id 0. */
  function toNum(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    scratchRetentionDays: 7,
    runsRetentionDays: 30,
    defaultMaxTokens: 16000
  });

  // Flush retry policy. Without a cap, a conflict the rebase cannot
  // resolve becomes a hot loop against the RPC.
  const MAX_FLUSH_ATTEMPTS = 5;
  const BACKOFF_MS = [0, 400, 1200, 3000, 8000];

  // ─────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────

  let sb = null;
  let currentUser = null;
  let prompts = [];
  let runs = [];
  let settings = { ...DEFAULT_SETTINGS };

  let cloudRevision = 0;
  let pendingMutations = new Map();
  let mutationSequence = 0;
  let flushAttempts = 0;

  let syncTimeout = null;
  let pullPromise = null;
  let flushPromise = null;
  let sessionStartPromise = null;
  let localDbPromise = null;
  let localWriteQueue = Promise.resolve();

  const listeners = { change: [], status: [] };

  function on(event, fn) {
    if (listeners[event] && typeof fn === 'function') listeners[event].push(fn);
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach(fn => {
      try { fn(payload); } catch (e) { console.error('[cloud] listener failed', e); }
    });
  }

  function setStatus(state, message) {
    emit('status', { state, message });
  }

  // ─────────────────────────────────────────────
  // CONFIG / CLIENT
  // ─────────────────────────────────────────────

  const PLACEHOLDERS = ['PUT_YOUR_SUPABASE_URL_HERE', 'PUT_YOUR_PUBLISHABLE_KEY_HERE', 'PUT_YOUR_SCHEMA_HERE'];

  function configured() {
    const c = window.SUPABASE_CONFIG;
    return Boolean(c && c.url && c.publishableKey && c.schema &&
      !PLACEHOLDERS.includes(c.url) &&
      !PLACEHOLDERS.includes(c.publishableKey) &&
      !PLACEHOLDERS.includes(c.schema));
  }

  function client() {
    if (sb) return sb;
    if (!configured()) return null;
    if (!window.supabase || !window.supabase.createClient) return null;
    sb = window.supabase.createClient(
      window.SUPABASE_CONFIG.url,
      window.SUPABASE_CONFIG.publishableKey,
      {
        db: { schema: window.SUPABASE_CONFIG.schema },
        auth: {
          // The session lives in localStorage and is refreshed in the
          // background, so signing in once keeps this browser signed in.
          persistSession: true,
          autoRefreshToken: true
        }
      }
    );
    return sb;
  }

  // ─────────────────────────────────────────────
  // IDs
  // ─────────────────────────────────────────────

  /* v1 used a bare Date.now(), so two devices creating a prompt in
     the same millisecond produced the same id under the same user and
     one silently overwrote the other. The extra three random digits
     keep the value sortable by creation time and inside int8, while
     making that collision unlikely. Existing ids stay valid — they
     are simply smaller numbers.

     1000 is the CEILING, not a preference: Date.now() * 1000 is about
     1.8e15, just under Number.MAX_SAFE_INTEGER (9.007e15). A larger
     multiplier would silently lose integer precision in JS and cause
     far worse collisions than the one it was meant to fix. */
  function newId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }

  // ─────────────────────────────────────────────
  // NORMALISE
  // ─────────────────────────────────────────────

  function normalizePrompt(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const id = toNum(p.id);
    if (id === null) return null;
    const createdAt = Number(p.createdAt || id || Date.now());
    return {
      id,
      title: String(p.title || ''),
      text: String(p.text || ''),
      category: String(p.category || ''),
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      notes: String(p.notes || ''),
      pinned: Boolean(p.pinned),
      section: safeSection(p.section),
      expiresAt: Number.isFinite(Number(p.expiresAt)) && Number(p.expiresAt) > 0
        ? Number(p.expiresAt) : null,
      runConfig: p.runConfig && typeof p.runConfig === 'object' ? p.runConfig : null,
      createdAt,
      updatedAt: Number(p.updatedAt || createdAt),
      order: Number.isFinite(Number(p.order)) ? Number(p.order) : createdAt,
      revision: Number(p.revision || 0)
    };
  }

  function promptFromRow(row) {
    return normalizePrompt({
      id: row.id,
      title: row.title,
      text: row.prompt_text,
      category: row.category,
      tags: row.tags,
      notes: row.notes,
      pinned: row.pinned,
      section: row.section,
      expiresAt: row.expires_at,
      runConfig: row.run_config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      order: row.sort_order,
      revision: row.revision
    });
  }

  function runFromRow(row) {
    return {
      id: Number(row.id),
      metaPromptId: row.meta_prompt_id === null ? null : Number(row.meta_prompt_id),
      metaPromptTitle: String(row.meta_prompt_title || ''),
      provider: String(row.provider || ''),
      requestedModel: String(row.requested_model || ''),
      servedModel: String(row.served_model || ''),
      responseId: String(row.response_id || ''),
      promptVersion: String(row.prompt_version || ''),
      input: String(row.input || ''),
      output: String(row.output || ''),
      status: row.status === 'error' ? 'error' : 'ok',
      errorMessage: String(row.error_message || ''),
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      costUsd: Number(row.cost_usd) || 0,
      durationMs: Number(row.duration_ms) || 0,
      keep: Boolean(row.keep),
      savedPromptId: row.saved_prompt_id === null ? null : Number(row.saved_prompt_id),
      createdAt: Number(row.created_at) || 0
    };
  }

  function runToRow(run, userId) {
    return {
      user_id: userId,
      id: Number(run.id),
      meta_prompt_id: run.metaPromptId === null || run.metaPromptId === undefined
        ? null : Number(run.metaPromptId),
      meta_prompt_title: String(run.metaPromptTitle || '').slice(0, 400),
      provider: String(run.provider || 'anthropic'),
      requested_model: String(run.requestedModel || ''),
      served_model: String(run.servedModel || ''),
      response_id: String(run.responseId || ''),
      prompt_version: String(run.promptVersion || ''),
      input: String(run.input || ''),
      output: String(run.output || ''),
      status: run.status === 'error' ? 'error' : 'ok',
      error_message: String(run.errorMessage || '').slice(0, 2000),
      input_tokens: Number(run.inputTokens) || 0,
      output_tokens: Number(run.outputTokens) || 0,
      cost_usd: Number(run.costUsd) || 0,
      duration_ms: Number(run.durationMs) || 0,
      keep: Boolean(run.keep),
      saved_prompt_id: run.savedPromptId === null || run.savedPromptId === undefined
        ? null : Number(run.savedPromptId),
      created_at: Number(run.createdAt) || Date.now()
    };
  }

  function normalizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const retention = (value, fallback) => {
      if (value === null) return null;                 // null = keep forever
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    };
    return {
      scratchRetentionDays: retention(s.scratchRetentionDays, DEFAULT_SETTINGS.scratchRetentionDays),
      runsRetentionDays: retention(s.runsRetentionDays, DEFAULT_SETTINGS.runsRetentionDays),
      defaultMaxTokens: Number(s.defaultMaxTokens) > 0
        ? Math.floor(Number(s.defaultMaxTokens)) : DEFAULT_SETTINGS.defaultMaxTokens
    };
  }

  // ─────────────────────────────────────────────
  // INDEXEDDB
  // ─────────────────────────────────────────────

  function openLocalDb() {
    if (localDbPromise) return localDbPromise;
    localDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Guarded individually so a v1 database upgrades in place
        // rather than being rebuilt — the outbox may hold unsent work.
        if (!db.objectStoreNames.contains('prompts')) {
          db.createObjectStore('prompts', { keyPath: ['userId', 'id'] })
            .createIndex('by_user', 'userId', { unique: false });
        }
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: ['userId', 'id'] })
            .createIndex('by_user', 'userId', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains('runs')) {
          db.createObjectStore('runs', { keyPath: ['userId', 'id'] })
            .createIndex('by_user', 'userId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    return localDbPromise;
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Local write aborted.'));
    });
  }

  async function readUserStore(storeName, userId) {
    const db = await openLocalDb();
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName)
      .index('by_user').getAll(IDBKeyRange.only(userId));
    const rows = await idbRequest(request);
    await idbDone(transaction);
    return rows;
  }

  // Writes are serialised through one promise chain so two rapid
  // edits cannot interleave transactions and lose one.
  function persistLocal({
    upserts = [], deletes = [], outboxPuts = [], outboxDeletes = [],
    runPuts = [], runDeletes = [], replaceRuns = null, revision = cloudRevision
  } = {}) {
    const userId = currentUser && currentUser.id;
    if (!userId) return Promise.resolve();

    localWriteQueue = localWriteQueue
      .catch(error => console.error('[cloud] previous local write failed', error))
      .then(async () => {
        const db = await openLocalDb();
        const transaction = db.transaction(['prompts', 'outbox', 'meta', 'runs'], 'readwrite');
        const promptStore = transaction.objectStore('prompts');
        const outboxStore = transaction.objectStore('outbox');
        const runStore = transaction.objectStore('runs');

        upserts.forEach(p => promptStore.put({ ...p, userId }));
        deletes.forEach(id => promptStore.delete([userId, Number(id)]));
        outboxPuts.forEach(m => outboxStore.put({ ...m, userId }));
        outboxDeletes.forEach(id => outboxStore.delete([userId, Number(id)]));

        if (replaceRuns) {
          const cursorRequest = runStore.index('by_user').openCursor(IDBKeyRange.only(userId));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
          };
          replaceRuns.forEach(r => runStore.put({ ...r, userId }));
        } else {
          runPuts.forEach(r => runStore.put({ ...r, userId }));
          runDeletes.forEach(id => runStore.delete([userId, Number(id)]));
        }

        transaction.objectStore('meta').put({ userId, cloudRevision: Number(revision || 0) });
        await idbDone(transaction);
      });
    return localWriteQueue;
  }

  async function loadLocal() {
    prompts = [];
    runs = [];
    cloudRevision = 0;
    pendingMutations = new Map();

    try {
      const db = await openLocalDb();
      const [promptRows, outboxRows, runRows] = await Promise.all([
        readUserStore('prompts', currentUser.id),
        readUserStore('outbox', currentUser.id),
        readUserStore('runs', currentUser.id)
      ]);
      const metaTransaction = db.transaction('meta', 'readonly');
      const meta = await idbRequest(metaTransaction.objectStore('meta').get(currentUser.id));
      await idbDone(metaTransaction);

      prompts = promptRows
        .map(({ userId, ...p }) => normalizePrompt(p))
        .filter(Boolean);
      runs = runRows
        .map(({ userId, ...r }) => r)
        .sort((a, b) => b.createdAt - a.createdAt);
      pendingMutations = new Map(
        outboxRows.map(({ userId, ...m }) => [Number(m.id), m])
      );
      cloudRevision = Number((meta && meta.cloudRevision) || 0);
    } catch (error) {
      console.error('[cloud] local load failed', error);
      prompts = [];
      runs = [];
      cloudRevision = 0;
      pendingMutations = new Map();
      throw error;
    }
  }

  async function clearLocalUserData(userId) {
    try {
      await localWriteQueue.catch(() => {});
      const db = await openLocalDb();
      const transaction = db.transaction(['prompts', 'outbox', 'meta', 'runs'], 'readwrite');
      ['prompts', 'outbox', 'runs'].forEach(storeName => {
        const request = transaction.objectStore(storeName)
          .index('by_user').openCursor(IDBKeyRange.only(userId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      });
      transaction.objectStore('meta').delete(userId);
      await idbDone(transaction);
    } catch (error) {
      console.error('[cloud] unable to clear local data', error);
    }
  }

  // ─────────────────────────────────────────────
  // MUTATIONS / OUTBOX
  // ─────────────────────────────────────────────

  function createUpsertMutation(prompt) {
    const previous = pendingMutations.get(Number(prompt.id));
    return {
      id: Number(prompt.id),
      action: 'upsert',
      expectedRevision: Number(
        (previous && previous.expectedRevision) !== undefined
          ? previous.expectedRevision
          : (prompt.revision || 0)
      ),
      prompt: { ...prompt },
      mutationId: `${Date.now()}-${++mutationSequence}`
    };
  }

  function createDeleteMutation({ id, deletedAt, revision }) {
    const previous = pendingMutations.get(Number(id));
    return {
      id: Number(id),
      action: 'delete',
      deletedAt: Number(deletedAt || Date.now()),
      expectedRevision: Number(
        (previous && previous.expectedRevision) !== undefined
          ? previous.expectedRevision
          : (revision || 0)
      ),
      mutationId: `${Date.now()}-${++mutationSequence}`
    };
  }

  function mutationToPayload(mutation) {
    if (mutation.action === 'delete') {
      return {
        id: mutation.id,
        action: 'delete',
        expected_revision: mutation.expectedRevision,
        deleted_at: mutation.deletedAt
      };
    }
    const p = mutation.prompt;
    return {
      id: mutation.id,
      action: 'upsert',
      expected_revision: mutation.expectedRevision,
      title: p.title,
      text: p.text,
      category: p.category || '',
      tags: p.tags || [],
      notes: p.notes || '',
      pinned: Boolean(p.pinned),
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      sort_order: p.order,
      section: safeSection(p.section),
      expires_at: p.expiresAt === null ? null : Number(p.expiresAt),
      run_config: p.runConfig || null
    };
  }

  function queueSave(delay = 700) {
    if (!currentUser) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      // The rejection is handled here rather than left on a bare
      // `void` call: performFlush awaits pullPromise, which rejects
      // whenever a pull fails, and that surfaced as an unhandled
      // rejection every time an edit landed during a failed sync.
      flushPending().catch(error => console.error('[cloud] flush failed', error));
    }, delay);
  }

  // ─────────────────────────────────────────────
  // PUBLIC WRITES — PROMPTS
  // ─────────────────────────────────────────────

  function savePrompts(changed = [], deletedRecords = []) {
    const normalized = changed.map(normalizePrompt).filter(Boolean);
    const mutations = [
      ...normalized.map(createUpsertMutation),
      ...deletedRecords.map(createDeleteMutation)
    ];
    mutations.forEach(m => pendingMutations.set(m.id, m));

    persistLocal({
      upserts: normalized,
      deletes: deletedRecords.map(r => r.id),
      outboxPuts: mutations
    }).catch(error => console.error('[cloud] local persist failed', error));

    flushAttempts = 0;
    queueSave();
    emit('change', { reason: 'prompts' });
  }

  function upsertPromptLocal(prompt) {
    const normalized = normalizePrompt(prompt);
    if (!normalized) return null;
    const index = prompts.findIndex(p => p.id === normalized.id);
    if (index >= 0) prompts[index] = normalized;
    else prompts.push(normalized);
    return normalized;
  }

  function removePromptLocal(id) {
    prompts = prompts.filter(p => p.id !== Number(id));
  }

  // ─────────────────────────────────────────────
  // FLUSH
  // ─────────────────────────────────────────────

  function nextBatch() {
    const batch = [];
    let bytes = 2;
    for (const mutation of pendingMutations.values()) {
      const payload = mutationToPayload(mutation);
      const size = new Blob([JSON.stringify(payload)]).size + 1;
      if (batch.length && (batch.length >= 100 || bytes + size > 900000)) break;
      batch.push({ mutation, payload });
      bytes += size;
    }
    return batch;
  }

  function flushPending() {
    if (!currentUser || pendingMutations.size === 0) return Promise.resolve();
    if (flushPromise) return flushPromise;

    let again = false;
    const task = performFlush()
      .then(shouldRetry => { again = Boolean(shouldRetry); })
      .finally(() => {
        if (flushPromise === task) flushPromise = null;
        if (again && currentUser && pendingMutations.size > 0) {
          // Bounded, with a backoff. An unresolvable conflict now
          // stops and reports instead of looping on the RPC.
          if (flushAttempts >= MAX_FLUSH_ATTEMPTS) {
            setStatus('error', 'Sync stalled');
            return;
          }
          const delay = BACKOFF_MS[Math.min(flushAttempts, BACKOFF_MS.length - 1)];
          flushAttempts += 1;
          queueSave(delay);
        }
      });
    flushPromise = task;
    return task;
  }

  async function performFlush() {
    // A pull already in flight owns the revision cursor; wait for it,
    // but never let its rejection escape as our own.
    if (pullPromise) await pullPromise.catch(() => {});
    if (!currentUser || pendingMutations.size === 0) return false;

    const c = client();
    if (!c) return false;
    const userId = currentUser.id;
    const batch = nextBatch();
    if (!batch.length) return false;

    setStatus('syncing', 'Saving…');
    try {
      await localWriteQueue.catch(() => {});
      const { data, error } = await c.rpc('apply_prompt_changes', {
        changes: batch.map(item => item.payload)
      });
      if (error) throw error;
      if (!currentUser || currentUser.id !== userId) return false;

      const resultsById = new Map((data || []).map(row => [Number(row.prompt_id), row]));
      const outboxDeletes = [];
      const outboxPuts = [];
      const localUpserts = [];

      batch.forEach(({ mutation }) => {
        const result = resultsById.get(mutation.id);
        if (!result) return;
        const newRevision = Number(result.new_revision || 0);
        cloudRevision = Math.max(cloudRevision, newRevision);

        const live = pendingMutations.get(mutation.id);
        const localPrompt = prompts.find(p => p.id === mutation.id);
        if (localPrompt) {
          localPrompt.revision = newRevision;
          localUpserts.push(localPrompt);
        }

        if (live && live.mutationId === mutation.mutationId) {
          pendingMutations.delete(mutation.id);
          outboxDeletes.push(mutation.id);
        } else if (live) {
          // The row was edited again while this batch was in flight;
          // rebase the queued mutation onto the revision we just made.
          live.expectedRevision = newRevision;
          if (live.prompt) live.prompt.revision = newRevision;
          outboxPuts.push(live);
        }
      });

      await persistLocal({
        upserts: localUpserts, outboxPuts, outboxDeletes, revision: cloudRevision
      });
      setStatus('synced', 'Synced');
      if (pendingMutations.size === 0) flushAttempts = 0;
      return pendingMutations.size > 0;
    } catch (error) {
      const message = String((error && error.message) || '');
      if (message.includes('PROMPT_VERSION_CONFLICT') || error.code === '40001') {
        // Pull an authoritative snapshot. Pending rows stay in the
        // outbox and are rebased by the pull before the queued retry.
        await syncFromCloud({ forceFull: true, fromConflict: true }).catch(() => {});
        return true;
      }
      console.error('[cloud] save failed', error);
      setStatus('error', 'Sync failed');
      return false;
    }
  }

  // ─────────────────────────────────────────────
  // PULL
  // ─────────────────────────────────────────────

  function syncFromCloud({ forceFull = false, fromConflict = false } = {}) {
    if (!currentUser) return Promise.resolve(false);
    if (!pullPromise) {
      const task = performPull(forceFull, fromConflict).finally(() => {
        if (pullPromise === task) pullPromise = null;
        if (currentUser && pendingMutations.size > 0) queueSave(0);
      });
      pullPromise = task;
    }
    return pullPromise.then(() => true).catch(() => false);
  }

  async function performPull(forceFull, fromConflict) {
    if (flushPromise && !fromConflict) await flushPromise.catch(() => {});
    if (!currentUser) return;
    const c = client();
    if (!c) return;

    const userId = currentUser.id;
    let cursor = forceFull ? 0 : cloudRevision;
    let newest = cloudRevision;
    const localUpserts = new Map();
    const localDeletes = new Set();
    const outboxPuts = new Map();
    let changed = false;

    setStatus('syncing', 'Checking…');
    try {
      for (;;) {
        const { data, error } = await c
          .from('prompt_items')
          .select(PROMPT_COLUMNS)
          .eq('user_id', userId)
          .gt('revision', cursor)
          .order('revision', { ascending: true })
          .limit(DELTA_PAGE_SIZE);
        if (error) throw error;
        if (!currentUser || currentUser.id !== userId) return;
        if (!data || !data.length) break;

        data.forEach(row => {
          const id = Number(row.id);
          const revision = Number(row.revision || 0);
          cursor = Math.max(cursor, revision);
          newest = Math.max(newest, revision);

          const pending = pendingMutations.get(id);
          if (pending) {
            // Local edit wins for now; rebase it onto the server
            // revision so the retry passes the concurrency check.
            pending.expectedRevision = revision;
            if (pending.prompt) pending.prompt.revision = revision;
            const local = prompts.find(p => p.id === id);
            if (local) local.revision = revision;
            outboxPuts.set(id, pending);
            return;
          }

          if (row.deleted_at !== null && row.deleted_at !== undefined) {
            removePromptLocal(id);
            localDeletes.add(id);
          } else {
            const prompt = promptFromRow(row);
            if (prompt) {
              upsertPromptLocal(prompt);
              localUpserts.set(id, prompt);
            }
          }
          changed = true;
        });

        if (data.length < DELTA_PAGE_SIZE) break;
      }

      cloudRevision = newest;
      await persistLocal({
        upserts: [...localUpserts.values()],
        deletes: [...localDeletes],
        outboxPuts: [...outboxPuts.values()],
        revision: cloudRevision
      });

      await pullRuns(userId).catch(error => console.error('[cloud] runs pull failed', error));
      await pullSettings(userId).catch(error => console.error('[cloud] settings pull failed', error));

      if (changed) emit('change', { reason: 'pull' });
      setStatus('synced', 'Synced');
    } catch (error) {
      console.error('[cloud] pull failed', error);
      setStatus('error', 'Sync failed');
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // RUNS
  // ─────────────────────────────────────────────

  async function pullRuns(userId) {
    const c = client();
    if (!c) return;
    const { data, error } = await c
      .from('prompt_runs')
      .select(RUN_COLUMNS)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(RUNS_PAGE_SIZE);
    if (error) throw error;
    if (!currentUser || currentUser.id !== userId) return;
    runs = (data || []).map(runFromRow);
    await persistLocal({ replaceRuns: runs });
    emit('change', { reason: 'runs' });
  }

  async function saveRun(run) {
    const c = client();
    if (!c || !currentUser) throw new Error('Not signed in.');
    const record = { ...run, id: run.id || newId(), createdAt: run.createdAt || Date.now() };
    const { error } = await c.from('prompt_runs').insert(runToRow(record, currentUser.id));
    if (error) throw error;
    runs.unshift(record);
    await persistLocal({ runPuts: [record] });
    emit('change', { reason: 'runs' });
    return record;
  }

  async function updateRun(id, patch) {
    const c = client();
    if (!c || !currentUser) throw new Error('Not signed in.');
    const target = runs.find(r => r.id === Number(id));
    if (!target) return null;

    const allowed = {};
    if (typeof patch.keep === 'boolean') allowed.keep = patch.keep;
    if (patch.savedPromptId !== undefined) {
      allowed.saved_prompt_id = patch.savedPromptId === null ? null : Number(patch.savedPromptId);
    }
    if (!Object.keys(allowed).length) return target;

    const { error } = await c.from('prompt_runs').update(allowed)
      .eq('user_id', currentUser.id).eq('id', Number(id));
    if (error) throw error;

    if (allowed.keep !== undefined) target.keep = allowed.keep;
    if (allowed.saved_prompt_id !== undefined) target.savedPromptId = allowed.saved_prompt_id;
    await persistLocal({ runPuts: [target] });
    emit('change', { reason: 'runs' });
    return target;
  }

  // GUARD: PostgREST turns a DELETE with no filter into "delete every
  // row". Refuse an empty or unusable id list before issuing it.
  async function deleteRuns(ids) {
    const clean = (Array.isArray(ids) ? ids : [])
      .map(toNum).filter(n => n !== null);
    if (!clean.length) {
      console.warn('[cloud] refusing run delete: no valid ids after filtering');
      return 0;
    }
    const c = client();
    if (!c || !currentUser) throw new Error('Not signed in.');

    // Chunked so a very large selection cannot build a URL the
    // server will reject outright.
    for (let i = 0; i < clean.length; i += 200) {
      const slice = clean.slice(i, i + 200);
      const { error } = await c.from('prompt_runs').delete()
        .eq('user_id', currentUser.id).in('id', slice);
      if (error) throw error;
    }

    const removed = new Set(clean);
    runs = runs.filter(r => !removed.has(r.id));
    await persistLocal({ runDeletes: clean });
    emit('change', { reason: 'runs' });
    return clean.length;
  }

  // ─────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────

  async function pullSettings(userId) {
    const c = client();
    if (!c) return;
    const { data, error } = await c
      .from('user_settings').select('settings').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    if (!currentUser || currentUser.id !== userId) return;
    settings = normalizeSettings(data && data.settings);
    emit('change', { reason: 'settings' });
  }

  async function saveSettings(patch) {
    const c = client();
    if (!c || !currentUser) throw new Error('Not signed in.');
    const next = normalizeSettings({ ...settings, ...(patch || {}) });
    const { error } = await c.from('user_settings').upsert({
      user_id: currentUser.id,
      settings: next,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
    settings = next;
    emit('change', { reason: 'settings' });
    return next;
  }

  // ─────────────────────────────────────────────
  // RETENTION SWEEP
  // ─────────────────────────────────────────────

  /* Nothing marked as worth keeping is ever removed by this.
     Library and Workshop are never touched by any automatic process —
     only Scratch past its expiry and Runs past their window, and
     within those only rows that are neither pinned/kept nor linked to
     something saved. */
  function sweepCandidates(now = Date.now()) {
    const expiredScratch = prompts.filter(p =>
      p.section === 'scratch' && !p.pinned && p.expiresAt && p.expiresAt <= now);

    const runsDays = settings.runsRetentionDays;
    const staleRuns = runsDays === null ? [] : runs.filter(r =>
      !r.keep && !r.savedPromptId && r.createdAt < now - runsDays * 86400000);

    return { expiredScratch, staleRuns };
  }

  async function runSweep() {
    if (!currentUser) return { prompts: 0, runs: 0 };
    const { expiredScratch, staleRuns } = sweepCandidates();

    if (expiredScratch.length) {
      const deletedAt = Date.now();
      expiredScratch.forEach(p => removePromptLocal(p.id));
      savePrompts([], expiredScratch.map(p => ({
        id: p.id, deletedAt, revision: p.revision || 0
      })));
    }
    if (staleRuns.length) {
      await deleteRuns(staleRuns.map(r => r.id)).catch(error => {
        console.error('[cloud] run sweep failed', error);
      });
    }
    return { prompts: expiredScratch.length, runs: staleRuns.length };
  }

  // ─────────────────────────────────────────────
  // AUTH / SESSION
  // ─────────────────────────────────────────────

  async function getSession() {
    const c = client();
    if (!c) return null;
    const { data, error } = await c.auth.getSession();
    if (error) throw error;
    return (data && data.session) || null;
  }

  async function signIn(email, password) {
    const c = client();
    if (!c) return { ok: false, error: 'Cloud sync is not configured (see supabase-config.js).' };
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    if (!data || !data.user) return { ok: false, error: 'Sign-in returned no session. Refresh and try again.' };
    return { ok: true, user: data.user };
  }

  async function signOut() {
    const c = client();
    if (!c) return { ok: true };
    const { error } = await c.auth.signOut();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  function onAuthChange(fn) {
    const c = client();
    if (!c) return;
    c.auth.onAuthStateChange((event, session) => fn(event, session));
  }

  function startSession(user) {
    if (!user) return Promise.reject(new Error('No authenticated user.'));
    if (currentUser && currentUser.id === user.id && sessionStartPromise) return sessionStartPromise;
    if (currentUser && currentUser.id === user.id) return Promise.resolve();

    currentUser = user;
    cloudRevision = 0;
    flushAttempts = 0;
    const userId = user.id;

    const task = (async () => {
      try {
        await loadLocal();
      } catch (e) {
        // Cached data is unavailable; the cloud pull below still works.
      }
      if (!currentUser || currentUser.id !== userId) return;
      emit('change', { reason: 'local' });
      // Do not hold the UI while the cloud loads. Errors are reported
      // through setStatus and cached data stays usable.
      syncFromCloud().catch(() => {});
    })();

    const tracked = task.finally(() => {
      if (sessionStartPromise === tracked) sessionStartPromise = null;
    });
    sessionStartPromise = tracked;
    return tracked;
  }

  function endSession() {
    const previousUserId = currentUser && currentUser.id;
    currentUser = null;
    sessionStartPromise = null;
    cloudRevision = 0;
    flushAttempts = 0;
    pendingMutations = new Map();
    prompts = [];
    runs = [];
    settings = { ...DEFAULT_SETTINGS };
    clearTimeout(syncTimeout);
    if (previousUserId) clearLocalUserData(previousUserId);
    emit('change', { reason: 'signout' });
  }

  window.PromptCloud = {
    configured,
    client,
    newId,
    SECTIONS,
    DEFAULT_SETTINGS,

    on,
    getUser: () => currentUser,
    getPrompts: () => prompts,
    getRuns: () => runs,
    getSettings: () => settings,

    getSession,
    signIn,
    signOut,
    onAuthChange,
    startSession,
    endSession,

    savePrompts,
    upsertPromptLocal,
    removePromptLocal,
    syncFromCloud,
    flushPending,

    saveRun,
    updateRun,
    deleteRuns,
    saveSettings,

    sweepCandidates,
    runSweep,

    // Exposed for tests and for script.js validation.
    normalizePrompt,
    normalizeSettings,
    promptFromRow,
    runFromRow,
    runToRow,
    mutationToPayload,
    safeSection
  };
})();
