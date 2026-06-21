import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSummarize, startAutoSummarizer, type AutoState } from './auto-summarizer.js';

const fresh = (): AutoState => ({ lastAt: 0, lastCount: 0 });

describe('shouldSummarize (A1.5 pure decision)', () => {
  // VARIANT 1 — enough new records + interval elapsed → yes.
  it('v1: fires when new records AND interval both satisfied', () => {
    assert.equal(shouldSummarize(fresh(), 5, 100_000, 60_000, 3), true);
  });

  // VARIANT 2 — too few new records → no (even if interval elapsed).
  it('v2: holds when too few new records', () => {
    assert.equal(shouldSummarize({ lastAt: 0, lastCount: 0 }, 2, 100_000, 60_000, 3), false);
  });

  // VARIANT 3 — interval not elapsed → no (even with many new records).
  it('v3: holds when the min interval has not elapsed', () => {
    assert.equal(shouldSummarize({ lastAt: 90_000, lastCount: 0 }, 50, 100_000, 60_000, 3), false);
  });

  // VARIANT 4 — boundary: exactly minNew new + exactly interval → yes.
  it('v4: fires exactly at the new-records + interval boundary', () => {
    assert.equal(shouldSummarize({ lastAt: 40_000, lastCount: 10 }, 13, 100_000, 60_000, 3), true);
  });

  // VARIANT 5 — no new records since last → never.
  it('v5: never fires with zero new records', () => {
    assert.equal(shouldSummarize({ lastAt: 0, lastCount: 20 }, 20, 999_999, 60_000, 3), false);
  });
});

describe('startAutoSummarizer (orchestration)', () => {
  it('summarizes each active dock once when due, then throttles by interval', async () => {
    const calls: string[] = [];
    let count = 10;
    let clock = 100_000;
    const h = startAutoSummarizer({
      store: {} as never,
      activeDocks: () => ['dock-a', 'dock-b'],
      countFor: () => count,
      summarizeAndCache: async (d) => { calls.push(d); },
      now: () => clock,
    });
    await h.tick(); // first tick: both due
    assert.deepEqual(calls.sort(), ['dock-a', 'dock-b'], 'both docks summarized once');

    // immediate second tick (interval NOT elapsed) → no new calls.
    count += 10; await h.tick();
    assert.deepEqual(calls.sort(), ['dock-a', 'dock-b'], 'throttled within the interval');

    // advance past the interval + more records → fires again.
    clock += 61_000; count += 10; await h.tick();
    assert.equal(calls.length, 4, 'fires again after the interval with new records');
    h.stop();
  });

  it('skips a dock with no new records', async () => {
    const calls: string[] = [];
    const h = startAutoSummarizer({
      store: {} as never,
      activeDocks: () => ['idle'],
      countFor: () => 0,          // never any records
      summarizeAndCache: async (d) => { calls.push(d); },
      now: () => 200_000,
    });
    await h.tick();
    assert.deepEqual(calls, [], 'an idle dock is never summarized');
    h.stop();
  });

  it('does not overlap summarize calls (a slow summarize blocks the next tick)', async () => {
    let active = 0; let maxActive = 0;
    const h = startAutoSummarizer({
      store: {} as never,
      activeDocks: () => ['d'],
      countFor: () => 99,
      summarizeAndCache: async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20)); active--;
      },
      now: () => Date.now(),
    });
    await Promise.all([h.tick(), h.tick(), h.tick()]);
    assert.equal(maxActive, 1, 'summarize never ran concurrently');
    h.stop();
  });
});
