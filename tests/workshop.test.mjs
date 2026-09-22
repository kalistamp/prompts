import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../workshop.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const { createStore } = context.window.WorkshopRecovery;
function storage() {
  const map = new Map();
  return { writes: 0, get length() { return map.size; }, key: i => [...map.keys()][i],
    getItem: k => map.get(k) || null, removeItem: k => map.delete(k),
    setItem(k, v) { this.writes++; map.set(k, v); } };
}
function server() {
  const rows = new Map();
  const api = {
    offline: false, dropResponse: false, beforeReply: null,
    async rpc(_, p) {
      if (api.offline) throw Error('offline');
      const old = rows.get(p.p_id);
      let success = false;
      if ((!old && !p.p_base) || old?.token === p.p_base) {
        rows.set(p.p_id, { id: p.p_id, token: p.p_token, snapshot: structuredClone(p.p_snapshot), updated_at: new Date().toISOString() });
        success = true;
      } else success = old?.token === p.p_token;
      if (api.beforeReply) { const fn = api.beforeReply; api.beforeReply = null; fn(); }
      if (api.dropResponse) { api.dropResponse = false; throw Error('lost acknowledgement'); }
      return { data: success };
    },
    from() { return { select() { return this; }, eq() { return this; }, order() { return this; },
      async range(a, b) { if (api.offline) throw Error('offline'); return { data: [...rows.values()].slice(a, b + 1) }; } }; }
  };
  return { api, rows };
}
let sequence = 0;
function store(local = storage(), remote = server(), userId = 'alice') {
  const statuses = [];
  const instance = createStore({ storage: local, client: () => remote.api, userId,
    uuid: () => `id-${++sequence}`, onStatus: s => statuses.push(s) });
  return { instance, local, remote, statuses };
}
const snapshot = draft => ({ draft, thread: { system: 'original system', messages: [
  { role: 'user', content: 'original input' }, { role: 'assistant', content: 'generated output' }
] }, options: { provider: 'groq', models: { groq: 'chosen-model' }, effort: 'high', maxTokens: 8000 } });

test('refresh recovers the complete local state; unchanged checkpoints do not write', () => {
  const a = store();
  a.instance.save(snapshot('unsent draft'));
  const writes = a.local.writes;
  a.instance.save(snapshot('unsent draft'));
  assert.equal(a.local.writes, writes);
  const b = store(a.local, a.remote);
  assert.deepEqual(JSON.parse(JSON.stringify(b.instance.open(b.instance.list()[0]))), snapshot('unsent draft'));
});
test('offline work syncs after reconnect and resumes on another device without a duplicate', async () => {
  const a = store(); a.remote.api.offline = true;
  a.instance.save(snapshot('offline'));
  await a.instance.sync();
  assert.equal(a.remote.rows.size, 0);
  a.remote.api.offline = false;
  await a.instance.sync();
  const b = store(storage(), a.remote);
  await b.instance.sync();
  b.instance.open(b.instance.list()[0]);
  b.instance.save(snapshot('continued'));
  await b.instance.sync();
  assert.equal(a.remote.rows.size, 1);
  assert.equal([...a.remote.rows.values()][0].snapshot.draft, 'continued');
});
test('two devices editing the same base preserve both branches', async () => {
  const a = store(); a.instance.save(snapshot('base')); await a.instance.sync();
  const b = store(storage(), a.remote); await b.instance.sync(); b.instance.open(b.instance.list()[0]);
  a.instance.save(snapshot('device A')); b.instance.save(snapshot('device B'));
  await a.instance.sync(); await b.instance.sync(); await b.instance.sync();
  assert.equal(a.remote.rows.size, 2);
  assert.deepEqual([...a.remote.rows.values()].map(r => r.snapshot.draft).sort(), ['device A', 'device B']);
  assert.equal([...a.remote.rows.values()].filter(r => r.snapshot.recoveryCopy).length, 1);
});
test('two tabs cannot overwrite each other in local storage', () => {
  const a = store(); a.instance.save(snapshot('base'));
  const b = store(a.local, a.remote); b.instance.open(b.instance.list()[0]);
  a.instance.save(snapshot('tab A')); b.instance.save(snapshot('tab B'));
  const drafts = a.instance.list().map(r => r.snapshot.draft);
  assert.ok(drafts.includes('tab A')); assert.ok(drafts.includes('tab B'));
});
test('a lost acknowledgement retries idempotently', async () => {
  const a = store(); a.instance.save(snapshot('answer'));
  a.remote.api.dropResponse = true;
  await a.instance.sync(); await a.instance.sync();
  assert.equal(a.remote.rows.size, 1);
  assert.equal(a.instance.current().dirty, false);
});
test('edits made while a cloud save is in flight stay pending with the acknowledged base', async () => {
  const a = store(); a.instance.save(snapshot('first'));
  a.remote.api.beforeReply = () => a.instance.save(snapshot('newer'));
  await a.instance.sync();
  assert.equal(a.instance.current().dirty, true);
  await a.instance.sync();
  assert.equal(a.remote.rows.size, 1);
  assert.equal([...a.remote.rows.values()][0].snapshot.draft, 'newer');
});
test('typing after a lost acknowledgement still retries the exact operation without a fork', async () => {
  const a = store(); a.instance.save(snapshot('first'));
  a.remote.api.dropResponse = true;
  await a.instance.sync();
  a.instance.save(snapshot('newer after disconnect'));
  await a.instance.sync(); await a.instance.sync();
  assert.equal(a.remote.rows.size, 1);
  assert.equal([...a.remote.rows.values()][0].snapshot.draft, 'newer after disconnect');
});
test('duplicate creates an independent session and leaves original intact', async () => {
  const a = store(); a.instance.save(snapshot('original')); await a.instance.sync();
  a.instance.open(a.instance.list()[0], true);
  a.instance.save(snapshot('copy')); await a.instance.sync();
  assert.equal(a.remote.rows.size, 2);
});
test('opening a cloud session without editing keeps one visible history entry', async () => {
  const a = store(); a.instance.save(snapshot('original')); await a.instance.sync();
  const b = store(storage(), a.remote); await b.instance.sync();
  b.instance.open(b.instance.list()[0]);
  assert.equal(b.instance.list().length, 1);
  b.instance.save(snapshot('edited'));
  assert.equal(b.instance.list().length, 1);
});
test('account isolation and stopped stores cannot write', () => {
  const a = store(); a.instance.save(snapshot('private'));
  const b = store(a.local, a.remote, 'bob');
  assert.equal(b.instance.list().length, 0);
  a.instance.stop(); const count = a.local.writes;
  a.instance.save(snapshot('after signout'));
  assert.equal(a.local.writes, count);
});
test('storage failure reports an error and does not claim a durable save', () => {
  const a = store(); a.local.setItem = () => { throw Error('quota'); };
  assert.equal(a.instance.save(snapshot('cannot save')), false);
  assert.equal(a.instance.current(), null);
  assert.match(a.statuses.at(-1), /Autosave failed/);
});
