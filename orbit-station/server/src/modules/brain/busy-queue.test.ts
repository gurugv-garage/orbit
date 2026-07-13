/**
 * BusyQueue + splitByAge — the pure half of the WI-1 busy-queue rework
 * (docs/findings/2026-07-13-busy-queue-black-hole.md Addendum 3). Every cell
 * of the drop/run decision is a one-line test here; the settle wiring is
 * settle.test.ts; the end-to-end contract is the smoke:midturn harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusyQueue, splitByAge, type HeardUtterance } from './busy-queue.js';

const u = (text: string, endedAt: number, dockId = 'd1'): HeardUtterance =>
  ({ dockId, text, startedAt: endedAt - 1_000, endedAt });

test('add/take preserves spoken order and clears the queue', () => {
  const q = new BusyQueue();
  q.add(u('a', 100));
  q.add(u('b', 200));
  assert.equal(q.size('d1'), 2);
  assert.deepEqual(q.take('d1').map((x) => x.text), ['a', 'b']);
  assert.equal(q.size('d1'), 0);
  assert.deepEqual(q.take('d1'), []); // idempotent on empty
});

test('docks are isolated', () => {
  const q = new BusyQueue();
  q.add(u('a', 100, 'd1'));
  q.add(u('b', 100, 'd2'));
  assert.deepEqual(q.take('d1').map((x) => x.text), ['a']);
  assert.equal(q.size('d2'), 1);
});

test('putBack (a held drain) goes in FRONT of anything queued meanwhile', () => {
  const q = new BusyQueue();
  q.add(u('held-1', 100));
  q.add(u('held-2', 200));
  const held = q.take('d1');
  q.add(u('newer', 300)); // heard while the drain was held
  q.putBack('d1', held);
  assert.deepEqual(q.take('d1').map((x) => x.text), ['held-1', 'held-2', 'newer']);
});

test('splitByAge: staleness is PER ITEM — a ghost cannot poison a fresh follow-up', () => {
  const now = 100_000;
  const cap = 20_000;
  // the RCA's exact failure: an 84s-old ghost queued with a 7s-old fresh line
  // used to kill BOTH (batch-level firstAt). Per-item: ghost drops, fresh runs.
  const { fresh, stale } = splitByAge([u('ghost', now - 84_000), u('fresh', now - 7_000)], now, cap);
  assert.deepEqual(stale.map((x) => x.text), ['ghost']);
  assert.deepEqual(fresh.map((x) => x.text), ['fresh']);
});

test('splitByAge: boundary — exactly at the cap still runs; just past drops', () => {
  const now = 100_000;
  const cap = 20_000;
  const { fresh, stale } = splitByAge([u('at-cap', now - cap), u('past-cap', now - cap - 1)], now, cap);
  assert.deepEqual(fresh.map((x) => x.text), ['at-cap']);
  assert.deepEqual(stale.map((x) => x.text), ['past-cap']);
});

test('splitByAge: empty input → empty output', () => {
  assert.deepEqual(splitByAge([], 0, 1), { fresh: [], stale: [] });
});
