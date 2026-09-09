import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const settingsSource = await readFile(new URL('../settings.js', import.meta.url), 'utf8');
const cloudSource = await readFile(new URL('../cloud.js', import.meta.url), 'utf8');
const diffSource = await readFile(new URL('../diff.js', import.meta.url), 'utf8');
const runnerSource = await readFile(new URL('../runner.js', import.meta.url), 'utf8');

/* Values created inside the vm carry that realm's prototypes, which
   deepStrictEqual treats as unequal even when the structure matches.
   JSON round-tripping brings them into this realm for comparison. */
const plain = value => JSON.parse(JSON.stringify(value));

/* One context per test, so a stored key or a cached prompt from one
   assertion cannot leak into the next. */
function harness() {
  const store = new Map();
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); }
  };

  const window = {
    SUPABASE_CONFIG: {
      url: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_test',
      schema: 'prompts'
    }
  };

  const logs = [];
  const context = {
    window,
    localStorage,
    console: { warn: (...a) => logs.push(a), error: (...a) => logs.push(a), log() {} },
    Date, Set, Map, Promise, JSON, Number, Boolean, String, Array, Object, Math, Uint32Array,
    Blob, TextDecoder, URL, URLSearchParams, fetch,
    setTimeout, clearTimeout, structuredClone,
    indexedDB: undefined
  };

  vm.runInNewContext(settingsSource, context);
  vm.runInNewContext(cloudSource, context);
  vm.runInNewContext(diffSource, context);
  vm.runInNewContext(runnerSource, context);

  return {
    Settings: window.PromptSettings,
    Cloud: window.PromptCloud,
    Runner: window.PromptRunner,
    Diff: window.PromptDiff,
    store,
    logs
  };
}

// ─────────────────────────────────────────────
// SETTINGS — credentials never leave the browser
// ─────────────────────────────────────────────

test('credentials round-trip through localStorage only', () => {
  const { Settings, store } = harness();

  Settings.writeCredentials({
    provider: 'anthropic',
    keys: { anthropic: '  sk-ant-secret-value-1234  ' },
    models: { anthropic: 'claude-opus-5' }
  });

  const read = Settings.readCredentials();
  assert.equal(read.keys.anthropic, 'sk-ant-secret-value-1234', 'key is trimmed and kept');
  assert.equal(read.models.anthropic, 'claude-opus-5');

  // Exactly one storage key holds credentials, and it is the
  // versioned blob — nothing else in the store carries the secret.
  const holders = [...store.entries()].filter(([, value]) => value.includes('sk-ant-secret'));
  assert.deepEqual(holders.map(([key]) => key), ['ps.credentials.v1']);
});

test('fingerprint masks the key and never returns it whole', () => {
  const { Settings } = harness();
  const key = 'sk-ant-api03-abcdefghijklmnop';
  const print = Settings.fingerprint(key);
  assert.ok(!print.includes('api03-abcdefghijkl'), 'middle of the key is not shown');
  assert.ok(print.startsWith('sk-ant-a'));
  assert.ok(print.endsWith('mnop'));
  assert.equal(Settings.fingerprint(''), '—');
  assert.equal(Settings.fingerprint('short'), 'set');
});

test('model catalog is invalidated when the key changes', () => {
  const { Settings } = harness();
  Settings.writeModelCatalog('anthropic', { models: ['claude-opus-5'], apiKey: 'key-one-1234567890' });

  assert.ok(Settings.readModelCatalog('anthropic', 'key-one-1234567890'), 'same key reads the cache');
  assert.equal(Settings.readModelCatalog('anthropic', 'key-two-0987654321'), null,
    'a different key must not reuse the cached list');
});

test('model catalog stores a fingerprint, not the key', () => {
  const { Settings, store } = harness();
  Settings.writeModelCatalog('anthropic', { models: ['m'], apiKey: 'sk-ant-verysecret-9999' });
  assert.ok(!store.get('ps.models.v1').includes('verysecret'),
    'the raw key must never be written into the model cache');
});

test('credentials left by the pre-Supabase version are dropped on read', () => {
  const { Settings, store } = harness();
  store.set('ps.credentials.v1', JSON.stringify({
    provider: 'anthropic', githubToken: 'ghp_leftover', gistId: 'abc123'
  }));
  Settings.readCredentials();
  const after = JSON.parse(store.get('ps.credentials.v1'));
  assert.equal(after.githubToken, undefined);
  assert.equal(after.gistId, undefined);
});

test('prefs default to dark and reject unknown values', () => {
  const { Settings } = harness();
  assert.equal(Settings.readPrefs().theme, 'dark');
  Settings.writePrefs({ theme: 'chartreuse', view: 'nonsense', section: 'workshop' });
  const prefs = Settings.readPrefs();
  assert.equal(prefs.theme, 'dark', 'an unknown theme falls back to dark');
  assert.equal(prefs.view, 'large');
  assert.equal(prefs.section, 'workshop');
});

// ─────────────────────────────────────────────
// CLOUD — the write payload
// ─────────────────────────────────────────────

test('mutationToPayload carries section, expires_at and run_config', () => {
  const { Cloud } = harness();
  // This is the regression test for the migration-order trap: if the
  // RPC or the payload loses `section`, every save silently resets a
  // Workshop prompt to Library.
  const payload = Cloud.mutationToPayload({
    id: 12, action: 'upsert', expectedRevision: 3,
    prompt: Cloud.normalizePrompt({
      id: 12, title: 'Meta', text: 'body', section: 'workshop',
      expiresAt: null, runConfig: { model: 'claude-opus-5' },
      createdAt: 1, updatedAt: 2, order: 5, revision: 3
    })
  });

  assert.equal(payload.section, 'workshop');
  assert.equal(payload.expires_at, null);
  assert.deepEqual(plain(payload.run_config), { model: 'claude-opus-5' });
  assert.equal(payload.expected_revision, 3);
  assert.equal(payload.sort_order, 5);
});

test('delete payload is a tombstone with the expected revision', () => {
  const { Cloud } = harness();
  const payload = Cloud.mutationToPayload({
    id: 9, action: 'delete', deletedAt: 1700, expectedRevision: 4
  });
  assert.equal(payload.action, 'delete');
  assert.equal(payload.deleted_at, 1700);
  assert.equal(payload.expected_revision, 4);
});

test('an unknown section is repaired rather than sent to Postgres', () => {
  const { Cloud } = harness();
  assert.equal(Cloud.safeSection('workshop'), 'workshop');
  assert.equal(Cloud.safeSection('archive'), 'library');
  assert.equal(Cloud.safeSection(undefined), 'library');
  // The CHECK constraint would reject the row and fail the whole
  // batch, so the repair has to happen before the write.
  assert.equal(Cloud.normalizePrompt({ id: 1, section: 'nope' }).section, 'library');
});

test('normalizePrompt rejects rows without a usable id', () => {
  const { Cloud } = harness();
  assert.equal(Cloud.normalizePrompt({ title: 'no id' }), null);
  assert.equal(Cloud.normalizePrompt(null), null);
  assert.equal(Cloud.normalizePrompt({ id: 'abc' }), null);
  assert.equal(Cloud.normalizePrompt({ id: '42' }).id, 42, 'a numeric string is accepted');
});

test('expiresAt only survives as a positive number', () => {
  const { Cloud } = harness();
  assert.equal(Cloud.normalizePrompt({ id: 1, expiresAt: 0 }).expiresAt, null);
  assert.equal(Cloud.normalizePrompt({ id: 1, expiresAt: null }).expiresAt, null);
  assert.equal(Cloud.normalizePrompt({ id: 1, expiresAt: 'soon' }).expiresAt, null);
  assert.equal(Cloud.normalizePrompt({ id: 1, expiresAt: 1700 }).expiresAt, 1700);
});

test('ids stay inside the safe-integer range', () => {
  const { Cloud } = harness();
  const a = Cloud.newId();
  // Precision is the invariant that actually matters: past
  // Number.MAX_SAFE_INTEGER, JS integer arithmetic silently rounds
  // and ids would collide far more often than the ms clash this
  // scheme exists to prevent.
  assert.ok(Number.isSafeInteger(a), `${a} must be a safe integer`);
  assert.ok(a > 1e15 && a < Number.MAX_SAFE_INTEGER);
});

test('ids drawn in the same millisecond are spread across the suffix', () => {
  const { Cloud } = harness();
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(Cloud.newId());
  // 1000 suffixes per millisecond is the ceiling the safe-integer
  // range allows, so 2000 draws inside one tick cannot all be
  // unique — around 860 distinct values is the expected result.
  // What matters is that the suffix is actually random: v1 used a
  // bare Date.now() and produced a single value here.
  assert.ok(seen.size > 600, `expected a spread of ids, got ${seen.size}`);
});

test('row mapping round-trips a run', () => {
  const { Cloud } = harness();
  const run = {
    id: 5, metaPromptId: 7, metaPromptTitle: 'Polish', provider: 'anthropic',
    requestedModel: 'claude-opus-5', servedModel: 'claude-opus-5-20260401',
    responseId: 'msg_1', promptVersion: 'ps-run-1', input: 'in', output: 'out',
    status: 'ok', errorMessage: '', inputTokens: 10, outputTokens: 20,
    costUsd: 0.001, durationMs: 900, keep: false, savedPromptId: null, createdAt: 1700
  };
  const back = Cloud.runFromRow(Cloud.runToRow(run, 'user-1'));
  assert.deepEqual(plain(back), run);
});

test('an unknown run status is coerced to the allowed set', () => {
  const { Cloud } = harness();
  const row = Cloud.runToRow({ id: 1, status: 'weird', createdAt: 1 }, 'u');
  assert.equal(row.status, 'ok');
  assert.equal(Cloud.runToRow({ id: 1, status: 'error', createdAt: 1 }, 'u').status, 'error');
});

test('retention settings treat null as keep forever', () => {
  const { Cloud } = harness();
  const settings = Cloud.normalizeSettings({ scratchRetentionDays: null, runsRetentionDays: 90 });
  assert.equal(settings.scratchRetentionDays, null);
  assert.equal(settings.runsRetentionDays, 90);
  // Nonsense falls back to the default rather than to "delete now".
  assert.equal(Cloud.normalizeSettings({ runsRetentionDays: -5 }).runsRetentionDays, 30);
  assert.equal(Cloud.normalizeSettings({ runsRetentionDays: 'soon' }).runsRetentionDays, 30);
});

// ─────────────────────────────────────────────
// CLOUD — the sweep never eats what you kept
// ─────────────────────────────────────────────

test('the sweep only ever considers expired, unpinned Scratch', () => {
  const { Cloud } = harness();
  const past = Date.now() - 86400000;
  const future = Date.now() + 86400000;

  Cloud.upsertPromptLocal({ id: 1, title: 'Lib', section: 'library', expiresAt: past });
  Cloud.upsertPromptLocal({ id: 2, title: 'Shop', section: 'workshop', expiresAt: past });
  Cloud.upsertPromptLocal({ id: 3, title: 'Pinned scratch', section: 'scratch', expiresAt: past, pinned: true });
  Cloud.upsertPromptLocal({ id: 4, title: 'Fresh scratch', section: 'scratch', expiresAt: future });
  Cloud.upsertPromptLocal({ id: 5, title: 'Stale scratch', section: 'scratch', expiresAt: past });
  Cloud.upsertPromptLocal({ id: 6, title: 'No expiry', section: 'scratch', expiresAt: null });

  const ids = plain(Cloud.sweepCandidates().expiredScratch.map(p => p.id));
  assert.deepEqual(ids, [5],
    'Library and Workshop are never touched, and pinned or unexpired Scratch survives');
});

test('deleteRuns refuses an empty or unusable id list', async () => {
  const { Cloud, logs } = harness();
  // PostgREST turns a DELETE with no filter into "delete every row",
  // so this guard runs before any client is even reached.
  assert.equal(await Cloud.deleteRuns([]), 0);
  assert.equal(await Cloud.deleteRuns(['abc', null, undefined]), 0);
  assert.equal(await Cloud.deleteRuns(null), 0);
  assert.ok(logs.length >= 3, 'each refusal is logged');
});

// ─────────────────────────────────────────────
// RUNNER — prompt assembly and pricing
// ─────────────────────────────────────────────

test('a meta-prompt is the system prompt and the idea is the user turn', () => {
  const { Runner } = harness();
  const out = Runner.assemble('You are a prompt engineer.', 'make a code reviewer');
  assert.equal(out.system, 'You are a prompt engineer.');
  assert.equal(out.user, 'make a code reviewer');
  assert.equal(out.interpolated, false);
});

test('{{input}} is interpolated inline when present', () => {
  const { Runner } = harness();
  const out = Runner.assemble('Summarise:\n{{input}}\nBe brief.', 'a long excerpt');
  assert.equal(out.system, 'Summarise:\na long excerpt\nBe brief.');
  assert.equal(out.interpolated, true);
  assert.ok(out.user.length > 0, 'the user turn is never empty');
});

test('{{input}} matching tolerates whitespace and repeats', () => {
  const { Runner } = harness();
  const out = Runner.assemble('{{ input }} and again {{input}}', 'X');
  assert.equal(out.system, 'X and again X');
});

test('cost is priced per million tokens', () => {
  const { Runner } = harness();
  // claude-opus-5 is $5/1M in, $25/1M out.
  const { costUsd, priced } = Runner.costFor('claude-opus-5', 1_000_000, 1_000_000);
  assert.equal(priced, true);
  assert.equal(costUsd, 30);
  assert.equal(Runner.costFor('claude-sonnet-5', 1_000_000, 0).costUsd, 2);
});

test('a dated snapshot prices as its family', () => {
  const { Runner } = harness();
  assert.deepEqual(plain(Runner.priceOf('claude-opus-5-20260401')), { in: 5, out: 25 });
});

test('an unknown model prices at zero and says so', () => {
  const { Runner } = harness();
  const { costUsd, priced } = Runner.costFor('some-other-model', 1000, 1000);
  assert.equal(costUsd, 0);
  assert.equal(priced, false, 'the run records that it could not be priced rather than guessing');
});

// ─────────────────────────────────────────────
// DIFF
// ─────────────────────────────────────────────

test('identical text produces no changes', () => {
  const { Diff } = harness();
  const rows = Diff.diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(rows.every(r => r.type === 'same'), true);
  assert.deepEqual(plain(Diff.summarise(rows)), { added: 0, removed: 0, changed: false });
});

test('a diff keeps the unchanged lines and marks the edits', () => {
  const { Diff } = harness();
  const rows = plain(Diff.diffLines('one\ntwo\nthree', 'one\nTWO\nthree'));
  assert.deepEqual(rows, [
    { type: 'same', text: 'one' },
    { type: 'remove', text: 'two' },
    { type: 'add', text: 'TWO' },
    { type: 'same', text: 'three' }
  ]);
  assert.deepEqual(plain(Diff.summarise(rows)), { added: 1, removed: 1, changed: true });
});

test('pure insertion removes nothing', () => {
  const { Diff } = harness();
  const summary = Diff.summarise(Diff.diffLines('a\nb', 'a\nmiddle\nb'));
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 0);
});

test('pure deletion adds nothing', () => {
  const { Diff } = harness();
  const summary = Diff.summarise(Diff.diffLines('a\ngone\nb', 'a\nb'));
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 1);
});

test('empty on both sides is a single unchanged blank line', () => {
  const { Diff } = harness();
  assert.deepEqual(plain(Diff.diffLines('', '')), [{ type: 'same', text: '' }]);
  assert.deepEqual(plain(Diff.diffLines(null, undefined)), [{ type: 'same', text: '' }]);
});

test('collapse hides long unchanged runs but keeps context', () => {
  const { Diff } = harness();
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 15', 'CHANGED');
  const collapsed = plain(Diff.collapse(Diff.diffLines(before, after), 2));

  assert.ok(collapsed.some(r => r.type === 'gap'), 'a gap marker stands in for the skipped lines');
  assert.ok(collapsed.some(r => r.type === 'add' && r.text === 'CHANGED'));
  assert.ok(collapsed.length < 20, `collapsed to ${collapsed.length} rows`);
});

test('an oversized comparison degrades instead of building a huge table', () => {
  const { Diff } = harness();
  // Past MAX_CELLS the LCS table would be tens of millions of cells,
  // so the whole body is reported as replaced rather than hanging.
  const lines = Math.ceil(Math.sqrt(Diff.MAX_CELLS)) + 10;
  const before = new Array(lines).fill('x').join('\n');
  const after = new Array(lines).fill('y').join('\n');
  const rows = Diff.diffLines(before, after);
  assert.equal(rows.filter(r => r.type === 'same').length, 0);
  assert.equal(rows.filter(r => r.type === 'remove').length, lines);
  assert.equal(rows.filter(r => r.type === 'add').length, lines);
});

// ─────────────────────────────────────────────
// VERSIONS — what counts as a change
// ─────────────────────────────────────────────

test('content edits are versioned', () => {
  const { Cloud } = harness();
  const base = Cloud.normalizePrompt({ id: 1, title: 'A', text: 'body', tags: ['x'], section: 'library' });
  const edit = field => Cloud.contentChanged(base, Cloud.normalizePrompt({ ...base, ...field }));

  assert.equal(edit({ title: 'B' }), true);
  assert.equal(edit({ text: 'other' }), true);
  assert.equal(edit({ category: 'New' }), true);
  assert.equal(edit({ notes: 'note' }), true);
  assert.equal(edit({ section: 'workshop' }), true);
  assert.equal(edit({ tags: ['x', 'y'] }), true);
});

test('pinning, reordering and expiry are not versions', () => {
  const { Cloud } = harness();
  const base = Cloud.normalizePrompt({ id: 1, title: 'A', text: 'body', tags: ['x'] });
  const edit = field => Cloud.contentChanged(base, Cloud.normalizePrompt({ ...base, ...field }));

  // Otherwise a drag or a star would bury the real edits.
  assert.equal(edit({ pinned: true }), false);
  assert.equal(edit({ order: 999 }), false);
  assert.equal(edit({ expiresAt: Date.now() }), false);
  assert.equal(edit({ updatedAt: Date.now() + 1 }), false);
  assert.equal(edit({}), false);
});

// ─────────────────────────────────────────────
// IMPORT
// ─────────────────────────────────────────────

test('an export from this app imports', () => {
  const { Cloud } = harness();
  const parsed = Cloud.parseImport(JSON.stringify({
    exportedAt: '2026-09-08T00:00:00Z',
    prompts: [
      { id: 1, title: 'One', text: 'a', section: 'workshop' },
      { id: 2, title: 'Two', text: 'b', section: 'scratch' }
    ]
  }));
  assert.equal(parsed.fresh.length, 2);
  assert.equal(parsed.duplicates.length, 0);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.fresh[0].section, 'workshop');
});

test('a whole-document backup and a bare array both import', () => {
  const { Cloud } = harness();
  const doc = Cloud.parseImport({ prompts: [{ id: 5, title: 'X', text: 'x' }], deleted: [] });
  assert.equal(doc.fresh.length, 1);
  // A backup from before sections existed lands in Library, the same
  // default the column takes.
  assert.equal(doc.fresh[0].section, 'library');

  const bare = Cloud.parseImport([{ id: 6, title: 'Y', text: 'y' }]);
  assert.equal(bare.fresh.length, 1);
});

test('a raw table dump maps prompt_text and sort_order', () => {
  const { Cloud } = harness();
  const parsed = Cloud.parseImport([{ id: 9, title: 'Row', prompt_text: 'from column', sort_order: 42 }]);
  assert.equal(parsed.fresh[0].text, 'from column');
  assert.equal(parsed.fresh[0].order, 42);
});

test('prompts already present are reported, never overwritten', () => {
  const { Cloud } = harness();
  Cloud.upsertPromptLocal({ id: 1, title: 'Mine', text: 'original' });

  const parsed = Cloud.parseImport([
    { id: 1, title: 'Theirs', text: 'replacement' },
    { id: 2, title: 'New', text: 'fresh' }
  ]);
  assert.equal(parsed.fresh.length, 1);
  assert.equal(parsed.duplicates.length, 1);

  Cloud.applyImport(parsed, 'skip');
  const mine = Cloud.getPrompts().find(p => p.id === 1);
  assert.equal(mine.title, 'Mine', 'the existing prompt is untouched');
  assert.equal(mine.text, 'original');
  assert.equal(Cloud.getPrompts().length, 2);
});

test('copy mode brings duplicates in under fresh ids', () => {
  const { Cloud } = harness();
  Cloud.upsertPromptLocal({ id: 1, title: 'Mine', text: 'original' });
  const parsed = Cloud.parseImport([{ id: 1, title: 'Theirs', text: 'replacement' }]);

  Cloud.applyImport(parsed, 'copy');
  const all = Cloud.getPrompts();
  assert.equal(all.length, 2);
  assert.equal(all.find(p => p.id === 1).text, 'original', 'the original still wins its id');
  const copy = all.find(p => p.id !== 1);
  assert.equal(copy.title, 'Theirs (imported)');
});

test('unusable entries are counted, not imported', () => {
  const { Cloud } = harness();
  const parsed = Cloud.parseImport([
    { id: 1, title: 'Good', text: 'yes' },
    { id: 2 },                    // no title and no body
    { title: 'No id', text: 'x' },
    null,
    'not an object'
  ]);
  assert.equal(parsed.fresh.length, 1);
  assert.equal(parsed.skipped, 4);
  assert.equal(parsed.total, 5);
});

test('a file that is not prompts is refused with a readable message', () => {
  const { Cloud } = harness();
  assert.throws(() => Cloud.parseImport('{ not json'), /not valid JSON/);
  assert.throws(() => Cloud.parseImport({ something: 'else' }), /No prompts found/);
});
