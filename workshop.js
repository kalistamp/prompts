/* Durable Workshop snapshots. Independent of prompt/run retention. No API keys.
   Each tab owns separate local records; cloud writes use compare-and-swap.
   A conflicting edit is preserved as a recovery copy, never rebased blindly. */
(function () {
  'use strict';
  function createStore({ storage, client, userId, uuid, onStatus = () => {}, onChange = () => {} }) {
    const prefix = `ps.workshop.v1:${userId}:`;
    const writer = uuid();
    let active = null, busy = false, stopped = false, saveFailed = false;
    const storageWarning = 'Autosave failed: browser storage is full or unavailable. Keep this page open and copy your work.';
    const status = message => onStatus(saveFailed ? storageWarning : message);
    const clone = value => JSON.parse(JSON.stringify(value));
    function readAll() {
      const rows = [];
      try { for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key.startsWith(prefix)) continue;
        try {
          const row = JSON.parse(storage.getItem(key));
          if (row.version === 1 && row.snapshot && row.id && row.token) rows.push({ ...row, key });
        } catch (_) { /* A broken record must not block other recoveries. */ }
      } } catch (_) { saveFailed = true; status(storageWarning); }
      return rows;
    }
    function put(row, key = row.key) {
      try {
        const serialized = JSON.stringify({ ...row, key });
        if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
        return true;
      } catch (_) {
        status(storageWarning);
        return false;
      }
    }
    function list() {
      const rows = readAll();
      // A pending local version takes precedence over its cached server base.
      const pendingIds = new Set(rows.filter(r => r.dirty).map(r => r.id));
      const remoteIds = new Set(rows.filter(r => r.remote).map(r => r.id));
      const superseded = new Set(rows.filter(r => r.source && r.dirty)
        .map(r => r.source.key + ':' + r.source.token));
      const seen = new Set();
      return rows.filter(r => !(r.remote && pendingIds.has(r.id)))
        .filter(r => r.remote || r.dirty || !remoteIds.has(r.id))
        .filter(r => !superseded.has(r.key + ':' + r.token))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter(r => {
          const key = r.id + ':' + r.token;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
    }
    function open(row, duplicate = false) {
      active = row ? clone(row) : null;
      if (active) {
        active.version = 1;
        active.source = row.key ? { key: row.key, token: row.token } : null;
        active.key = prefix + writer + ':' + (duplicate ? uuid() : active.id);
        if (duplicate) {
          delete active.inflight;
          active.updatedAt = Date.now();
          active.id = active.key.split(':').pop();
          active.base = null; active.token = uuid(); active.dirty = true;
        } else if (!active.dirty) active.base = active.token;
        active.remote = false;
      }
      return active && clone(active.snapshot);
    }
    function save(snapshot) {
      if (stopped) return false;
      if (active && JSON.stringify(active.snapshot) === JSON.stringify(snapshot)) return true;
      const row = active || { version: 1, id: uuid(), base: null };
      const next = { ...row, snapshot: clone(snapshot), token: uuid(), dirty: true,
        updatedAt: Date.now(), remote: false };
      next.key = prefix + writer + ':' + next.id;
      if (!put(next)) { saveFailed = true; return false; }
      saveFailed = false;
      active = next;
      status('Saved on this device · waiting for cloud sync');
      return true;
    }
    async function sync() {
      if (busy || stopped) return;
      busy = true;
      try {
        const c = client();
        if (!c) throw new Error('Cloud unavailable');
        // Only this tab's writes are uploaded. Old pending records are adopted
        // when recovered, preventing two tabs from racing to upload an outbox.
        const pending = readAll().filter(r => r.dirty && r.key.startsWith(prefix + writer + ':'));
        for (const row of pending) {
          // Retain the exact operation until acknowledged, even if typing
          // creates a newer snapshot while the connection is interrupted.
          const operation = row.inflight || { token: row.token, base: row.base, snapshot: row.snapshot };
          row.inflight = operation;
          if (!put(row)) return;
          if (active && active.key === row.key) active = row;
          const { data, error } = await c.rpc('save_workshop_session', {
            p_id: row.id, p_base: operation.base, p_token: operation.token, p_snapshot: operation.snapshot
          });
          if (stopped) return;
          if (error) throw error;
          const latest = JSON.parse(storage.getItem(row.key) || 'null');
          if (!latest) continue;
          if (!data) {
            // Preserve the losing branch under a new identity. The original
            // remains on the server and will appear alongside this copy.
            latest.id = uuid(); latest.base = null;
            delete latest.inflight;
            latest.snapshot.recoveryCopy = true;
            latest.key = prefix + writer + ':' + latest.id;
            if (put(latest)) {
              storage.removeItem(row.key);
              if (active && active.key === row.key) active = latest;
            }
            status('Another device changed this conversation. Both versions are preserved in History.');
            continue;
          }
          latest.base = operation.token;
          latest.dirty = latest.token !== operation.token;
          delete latest.inflight;
          if (latest.source && latest.source.key !== row.key) {
            const source = JSON.parse(storage.getItem(latest.source.key) || 'null');
            if (source && source.token === latest.source.token) storage.removeItem(latest.source.key);
            latest.source = null;
          }
          put(latest);
          if (active && active.key === row.key) active = latest;
        }
        let offset = 0, fetched;
        do {
          const { data, error } = await c.from('workshop_sessions').select('*')
            .eq('user_id', userId).order('id').range(offset, offset + 99);
          if (stopped) return;
          if (error) throw error;
          fetched = data || [];
          for (const row of fetched) {
            const cached = { version: 1, id: row.id, token: row.token, base: row.token,
              snapshot: row.snapshot, updatedAt: Date.parse(row.updated_at), dirty: false, remote: true,
              key: prefix + 'remote:' + row.id };
            put(cached);
            // Remove acknowledged stale local caches, but never pending work.
            for (const local of readAll()) {
              if (!local.remote && !local.dirty && local.id === row.id &&
                  (!active || active.key !== local.key)) storage.removeItem(local.key);
            }
          }
          offset += fetched.length;
        } while (fetched.length === 100);
        status(readAll().some(r => r.dirty)
          ? 'Saved locally · recover pending drafts to sync them'
          : 'Workshop saved to cloud');
        onChange();
      } catch (_) {
        if (!stopped) status('Saved on this device · cloud unavailable; will retry');
      } finally { busy = false; }
    }
    function adopt(row, duplicate = false) {
      const snapshot = open(row, duplicate);
      if (active) {
        if (duplicate) active.source = null;
        put(active);
      }
      return snapshot;
    }
    return { list, save, sync, open: adopt, reset: () => { active = null; },
      current: () => active && clone(active), stop: () => { stopped = true; } };
  }
  window.WorkshopRecovery = { createStore };
})();
