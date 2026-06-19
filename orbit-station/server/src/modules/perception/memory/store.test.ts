/**
 * MemoryStore (docs/perception-to-agent.md Decision 4) — the unified per-dock
 * evolving memory. Tested against an in-memory sqlite + a deterministic fake
 * embedder (no file, no network): remember/get, revise→supersede chain (history
 * kept), forget, structured recall (type/subject/interval), semantic cosine
 * ranking, lineage, and the orientation helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MemoryStore, cosine, normSubject, type Embedder } from './store.js';

/** Deterministic fake embedder: a tiny bag-of-words vector over a fixed vocab, so
 *  texts sharing words score higher on cosine — enough to test ranking, no network. */
const VOCAB = ['tea', 'coffee', 'flight', 'guru', 'kitchen', 'debugging', 'frustrated', 'lunch', 'cat', 'water'];
const fakeEmbed: Embedder = async (text: string) => {
  const t = text.toLowerCase();
  const v = new Float32Array(VOCAB.length);
  VOCAB.forEach((w, i) => { if (t.includes(w)) v[i] = 1; });
  return v;
};

function store(embed: Embedder = fakeEmbed) {
  return new MemoryStore(new Database(':memory:'), embed);
}
const DOCK = 'desk-1';

test('cosine + normSubject primitives', () => {
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.ok(Math.abs(cosine(new Float32Array([1, 1]), new Float32Array([1, 0])) - Math.SQRT1_2) < 1e-6);
  assert.equal(cosine(new Float32Array([]), new Float32Array([1])), 0); // mismatched
  assert.equal(normSubject('  Guru  GV '), 'guru gv');
  assert.equal(normSubject(undefined), '');
});

test('remember + get: stores axes, confidence, defaults', async () => {
  const s = store();
  const id = await s.remember({ dockId: DOCK, type: 'preference', subject: 'Guru', claim: 'prefers tea', confidence: 0.8 });
  const m = s.get(id)!;
  assert.equal(m.type, 'preference');
  assert.equal(m.subject, 'guru');         // normalized
  assert.equal(m.claim, 'prefers tea');
  assert.equal(m.confidence, 0.8);
  assert.equal(m.derivation, 'observed');  // default
  assert.equal(m.status, 'active');
  assert.equal(m.validTo, null);
});

test('revise: supersede chain — new active version, old kept as revised', async () => {
  const s = store();
  const id1 = await s.remember({ dockId: DOCK, type: 'preference', subject: 'guru', claim: 'prefers tea' });
  const id2 = await s.revise(id1, { claim: 'now prefers coffee', confidence: 0.9 });
  assert.ok(id2 && id2 !== id1);

  const old = s.get(id1)!;
  const neu = s.get(id2!)!;
  assert.equal(old.status, 'revised');     // history kept, not deleted
  assert.ok(old.validTo != null);          // interval closed
  assert.equal(neu.status, 'active');
  assert.equal(neu.claim, 'now prefers coffee');
  assert.equal(neu.confidence, 0.9);
  assert.equal(neu.supersedes, id1);       // lineage of the revision
  assert.equal(neu.subject, 'guru');       // carried over

  // revising a non-active memory is a no-op
  assert.equal(await s.revise(id1, { claim: 'x' }), null);
});

test('forget: purges from active recall but row + history remain', async () => {
  const s = store();
  const id = await s.remember({ dockId: DOCK, type: 'fact', claim: 'the wifi password is on the fridge' });
  assert.equal(s.forget(id), true);
  assert.equal(s.get(id)!.status, 'forgotten');
  assert.equal(s.forget(id), false);       // idempotent-ish: already forgotten
  const active = await s.recall({ dockId: DOCK });
  assert.equal(active.length, 0);
  const all = await s.recall({ dockId: DOCK, includeInactive: true });
  assert.equal(all.length, 1);             // still there for history
});

test('recall: structured filters (type, subject, interval) + dock isolation', async () => {
  const s = store();
  await s.remember({ dockId: DOCK, type: 'person', subject: 'guru', claim: 'a person named Guru' });
  await s.remember({ dockId: DOCK, type: 'preference', subject: 'guru', claim: 'prefers tea' });
  await s.remember({ dockId: DOCK, type: 'place', subject: 'kitchen', claim: 'the kitchen is down the hall' });
  await s.remember({ dockId: 'other-dock', type: 'fact', subject: 'guru', claim: 'should not leak' });

  assert.equal((await s.recall({ dockId: DOCK })).length, 3);                       // dock-scoped
  assert.equal((await s.recall({ dockId: DOCK, type: 'preference' })).length, 1);
  assert.equal((await s.recall({ dockId: DOCK, subject: 'Guru' })).length, 2);      // normalized match
  assert.equal((await s.recall({ dockId: DOCK, subject: 'kitchen' }))[0]!.type, 'place');
});

test('recall: interval overlap on the valid window', async () => {
  const s = store();
  const t0 = Date.now();
  await s.remember({ dockId: DOCK, type: 'event', claim: 'morning standup', validFrom: t0 - 3_600_000 });
  await s.remember({ dockId: DOCK, type: 'event', claim: 'just now', validFrom: t0 });
  // window = last 10 min → only the recent one
  const recent = await s.recall({ dockId: DOCK, interval: { from: t0 - 600_000 } });
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.claim, 'just now');
});

test('recall: semantic query ranks by cosine (closest claim first)', async () => {
  const s = store();
  await s.remember({ dockId: DOCK, type: 'fact', claim: 'we talked about my flight to Delhi' });
  await s.remember({ dockId: DOCK, type: 'preference', claim: 'likes coffee in the morning' });
  await s.remember({ dockId: DOCK, type: 'event', claim: 'the cat knocked over a cup' });

  const hits = await s.recall({ dockId: DOCK, query: 'did we ever talk about my flight?' });
  assert.equal(hits[0]!.claim, 'we talked about my flight to Delhi', 'flight memory ranks first');

  const coffee = await s.recall({ dockId: DOCK, query: 'what do they drink, coffee?' });
  assert.equal(coffee[0]!.claim, 'likes coffee in the morning');
});

test('recall: query falls back to recency when the embedder is down', async () => {
  const downEmbed: Embedder = async () => null;
  const s = store(downEmbed);
  await s.remember({ dockId: DOCK, type: 'fact', claim: 'first' });
  await s.remember({ dockId: DOCK, type: 'fact', claim: 'second' });
  const hits = await s.recall({ dockId: DOCK, query: 'anything' });
  assert.equal(hits.length, 2);                 // not dropped
  assert.equal(hits[0]!.claim, 'second');       // recency order
});

test('lineage: derived memory records what it was built from', async () => {
  const s = store();
  const id = await s.remember({
    dockId: DOCK, type: 'summary', derivation: 'derived',
    claim: 'Guru spent the morning debugging and seemed frustrated',
    lineage: [
      { sourceKind: 'snapshot', sourceId: 'vision-1' },
      { sourceKind: 'snapshot', sourceId: 'speech-7' },
    ],
  });
  const edges = s.lineage(id);
  assert.equal(edges.length, 2);
  assert.deepEqual(edges.map((e) => e.sourceId).sort(), ['speech-7', 'vision-1']);
  assert.equal(s.get(id)!.derivation, 'derived');
});

test('orientation helpers: subjects, recent, count', async () => {
  const s = store();
  await s.remember({ dockId: DOCK, type: 'person', subject: 'guru', claim: 'Guru' });
  await s.remember({ dockId: DOCK, type: 'place', subject: 'kitchen', claim: 'the kitchen' });
  await s.remember({ dockId: DOCK, type: 'fact', claim: 'a subject-less fact' }); // no subject
  assert.deepEqual(s.subjects(DOCK), ['guru', 'kitchen']);  // subject-less excluded, sorted
  assert.equal(s.count(DOCK), 3);
  assert.equal(s.recent(DOCK, 2).length, 2);
});

test('subjects/count exclude forgotten + revised', async () => {
  const s = store();
  const id = await s.remember({ dockId: DOCK, type: 'person', subject: 'alice', claim: 'Alice' });
  await s.remember({ dockId: DOCK, type: 'person', subject: 'bob', claim: 'Bob' });
  s.forget(id);
  assert.deepEqual(s.subjects(DOCK), ['bob']);
  assert.equal(s.count(DOCK), 1);
});
