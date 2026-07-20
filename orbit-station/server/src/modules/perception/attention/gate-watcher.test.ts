/**
 * The attention-gate watcher's PURE signal extraction (deriveSignals + namesIn):
 * arrival/departure diffing, camera-motion + strong-emotion reads from the latest
 * records. No store, no clock. (The live wiring is covered by the E2E test.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot, type SnapshotRecord, type SnapshotSource } from '../snapshots.js';
import { deriveSignals, namesIn } from './gate-watcher.js';

const DOCK = 'desk-1';
const t = new Date(1_000_000);

function rec(kind: SnapshotSource['kind'], text: string, payload: Record<string, unknown> = {}): SnapshotRecord {
  return makeSnapshot({
    dockId: DOCK, source: { id: 'cam-0', kind, device: 'd', host: 'h' },
    model: { name: 'm', endpoint: 'e' }, from: t, to: t, payload: { text, ...payload },
  });
}

test('namesIn: identity faces → names, unknown → "someone", empty → []', () => {
  assert.deepEqual(namesIn(rec('identity', 'guru', { faces: [{ name: 'guru' }, { name: null }] })), ['guru', 'someone']);
  assert.deepEqual(namesIn(rec('identity', 'no one', { faces: [] })), []);
  assert.deepEqual(namesIn(rec('speech', 'hi')), []); // wrong kind
  assert.deepEqual(namesIn(undefined), []);
});

const base = { now: 2_000_000, msSinceLastSnapshot: 100, lastRaisedAt: 0, cameraMoving: false };

test('arrival: present minus prev', () => {
  const s = deriveSignals({
    ...base,
    latestIdentity: rec('identity', 'guru', { faces: [{ name: 'guru' }] }),
    prevPresent: [],
  });
  assert.deepEqual(s.arrivedNames, ['guru']);
  assert.deepEqual(s.departedNames, []);
  assert.deepEqual(s.presentNames, ['guru']);
});

test('departure: prev minus present', () => {
  const s = deriveSignals({
    ...base,
    latestIdentity: rec('identity', 'no one', { faces: [] }),
    prevPresent: ['guru'],
  });
  assert.deepEqual(s.arrivedNames, []);
  assert.deepEqual(s.departedNames, ['guru']);
});

test('no change: nobody arrived/departed when the set is stable', () => {
  const s = deriveSignals({
    ...base,
    latestIdentity: rec('identity', 'guru', { faces: [{ name: 'guru' }] }),
    prevPresent: ['guru'],
  });
  assert.deepEqual(s.arrivedNames, []);
  assert.deepEqual(s.departedNames, []);
});

test('camera motion is the passed-in flag (from MotionExecutor.recentlyMoved), not inferred', () => {
  const moving = deriveSignals({ ...base, cameraMoving: true, prevPresent: [] });
  assert.equal(moving.cameraMoving, true);
  const still = deriveSignals({ ...base, cameraMoving: false, prevPresent: [] });
  assert.equal(still.cameraMoving, false);
});

test('strong emotion only from a confident "looked X" read (not "seemed a little")', () => {
  const strong = deriveSignals({ ...base, latestEmotion: rec('emotion', 'guru looked frustrated'), prevPresent: [] });
  assert.deepEqual(strong.strongEmotion, { name: 'guru', text: 'guru looked frustrated' });
  const soft = deriveSignals({ ...base, latestEmotion: rec('emotion', 'guru seemed a little tired'), prevPresent: [] });
  assert.equal(soft.strongEmotion, undefined); // hedged read is not "strong"
});

test('relevance is always undefined today (A1 stub)', () => {
  const s = deriveSignals({ ...base, prevPresent: [] });
  assert.equal(s.relevance, undefined);
});

test('passes cooldown/dedup inputs through unchanged', () => {
  const s = deriveSignals({ ...base, lastRaisedAt: 123, lastRaisedKey: 'arrival:guru', prevPresent: [] });
  assert.equal(s.lastRaisedAt, 123);
  assert.equal(s.lastRaisedKey, 'arrival:guru');
});
