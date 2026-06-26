/**
 * DockMemory — a task's DIRECT, dock-scoped handle on the durable store (NOT a wire
 * capability; memory is reconstructible from shared code + `.env`). Tests the ops +
 * the dock-scoping guarantee (the dock is BOUND, so a task can only touch its own
 * dock's beliefs), over a REAL in-memory MemoryStore (only the embedder is faked).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MemoryStore, type Embedder } from '../../modules/perception/memory/store.js';
import { DockMemory } from './memory.js';

const fakeEmbed: Embedder = async (t: string) => {
  const v = new Float32Array(8);
  for (const w of t.toLowerCase().split(/\W+/)) if (w) v[w.length % 8] = (v[w.length % 8] ?? 0) + 1;
  return v;
};

/** A shared store + two dock-scoped handles over it (alpha, beta). */
function fixture() {
  const store = new MemoryStore(new Database(':memory:'), fakeEmbed);
  return { store, alpha: new DockMemory('alpha', store), beta: new DockMemory('beta', store) };
}

test('remember → recall round-trips a belief, scoped to the dock', async () => {
  const { alpha } = fixture();
  const id = await alpha.remember({ type: 'preference', claim: 'guru prefers tea', subject: 'guru', confidence: 0.8 });
  assert.ok(id);
  const rows = await alpha.recall({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.claim, 'guru prefers tea');
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['claim', 'confidence', 'createdAt', 'id', 'subject', 'type']);
});

test('remember refuses an empty claim', async () => {
  const { alpha } = fixture();
  await assert.rejects(() => alpha.remember({ type: 'fact', claim: '   ' }), /non-empty claim/);
});

test('revise supersedes (new id) and recall shows the corrected claim', async () => {
  const { alpha } = fixture();
  const id = await alpha.remember({ type: 'preference', claim: 'guru prefers tea', subject: 'guru' });
  const newId = await alpha.revise(id, { claim: 'guru prefers coffee', confidence: 0.7 });
  assert.ok(newId && newId !== id);
  const rows = await alpha.recall({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.claim, 'guru prefers coffee');
});

test('forget retires a belief from active recall', async () => {
  const { alpha } = fixture();
  const id = await alpha.remember({ type: 'fact', claim: 'the kettle is broken' });
  assert.equal(await alpha.forget(id), true);
  assert.equal((await alpha.recall({})).length, 0);
});

test('DOCK-SCOPING: recall only sees the bound dock', async () => {
  const { alpha, beta } = fixture();
  await alpha.remember({ type: 'fact', claim: 'alpha fact' });
  await beta.remember({ type: 'fact', claim: 'beta fact' });
  assert.deepEqual((await alpha.recall({})).map((r) => r.claim), ['alpha fact']);
  assert.deepEqual((await beta.recall({})).map((r) => r.claim), ['beta fact']);
});

test('DOCK-SCOPING: beta cannot revise/forget/inspect alpha\'s belief', async () => {
  const { alpha, beta } = fixture();
  const id = await alpha.remember({ type: 'fact', claim: 'alpha-only secret' });
  await assert.rejects(() => beta.revise(id, { claim: 'hijacked' }), /another dock/);
  await assert.rejects(() => beta.forget(id), /another dock/);
  assert.equal(await beta.inspect(id), undefined);
  // alpha's belief intact
  assert.deepEqual((await alpha.recall({})).map((r) => r.claim), ['alpha-only secret']);
});

test('inspect returns the belief + lineage for the owning dock', async () => {
  const { alpha } = fixture();
  const id = await alpha.remember({ type: 'fact', claim: 'a fact' });
  const got = await alpha.inspect(id);
  assert.equal(got?.memory.claim, 'a fact');
  assert.ok(Array.isArray(got?.lineage));
});
