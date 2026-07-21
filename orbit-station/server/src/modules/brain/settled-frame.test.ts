/**
 * pickSettledFrame — the post-move settle guard behind take_photo/capture_photo/visual_query.
 * The bug it fixes: after the body turns to face someone, latest() still holds the PRE-TURN
 * frame (the grabber decodes ~1-2 fps), so the tool photographed the old view (the "empty
 * balcony after finding Guru" bug). This proves the frame-selection decision deterministically
 * with an injected clock — no real timers, no live dock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSettledFrame } from './tools.js';

// a controllable clock + a no-op sleep that advances it, so polling is deterministic.
function harness(start = 100_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

test('no recent move → returns latest immediately (movedAt 0)', async () => {
  const h = harness();
  const got = await pickSettledFrame({
    movedAt: 0,
    latest: () => 'LATEST',
    frameSince: () => { throw new Error('should not poll when nothing moved'); },
    now: h.now, sleep: h.sleep,
  });
  assert.equal(got, 'LATEST');
});

test('move long ago (past the whole budget) → latest, no polling', async () => {
  const h = harness();
  const got = await pickSettledFrame({
    movedAt: h.now() - 10_000, // moved 10s ago, well past settle+decode
    latest: () => 'LATEST',
    frameSince: () => { throw new Error('should not poll — settle window long gone'); },
    now: h.now, sleep: h.sleep,
    settleMs: 350, decodeMaxMs: 1200,
  });
  assert.equal(got, 'LATEST');
});

test('JUST moved, a post-settle frame is available → returns it, NOT the stale latest', async () => {
  const h = harness();
  const movedAt = h.now();
  // frameSince returns a fresh frame as soon as we ask for one at/after the settle instant.
  const got = await pickSettledFrame({
    movedAt,
    latest: () => 'STALE_PRETURN', // the bug's frame
    frameSince: (minTs) => (minTs === movedAt + 350 ? 'FRESH_POSTSETTLE' : undefined),
    now: h.now, sleep: h.sleep,
    settleMs: 350, decodeMaxMs: 1200,
  });
  assert.equal(got, 'FRESH_POSTSETTLE', 'must wait for the post-turn frame, not serve the pre-turn one');
});

test('JUST moved, post-settle frame arrives only after a couple polls', async () => {
  const h = harness();
  const movedAt = h.now();
  let polls = 0;
  const got = await pickSettledFrame({
    movedAt,
    latest: () => 'STALE',
    frameSince: () => { polls += 1; return polls >= 3 ? 'FRESH' : undefined; }, // lands on the 3rd poll
    now: h.now, sleep: h.sleep,
    settleMs: 350, decodeMaxMs: 1200, pollMs: 80,
  });
  assert.equal(got, 'FRESH');
  assert.ok(polls >= 3, 'polled until the fresh frame decoded');
});

test('JUST moved but NO post-settle frame ever arrives → falls back to latest (never fails)', async () => {
  const h = harness();
  const movedAt = h.now();
  const got = await pickSettledFrame({
    movedAt,
    latest: () => 'FALLBACK_LATEST',
    frameSince: () => undefined, // decode never catches up (stream stalled)
    now: h.now, sleep: h.sleep,
    settleMs: 350, decodeMaxMs: 1200, pollMs: 80,
  });
  assert.equal(got, 'FALLBACK_LATEST', 'degrades to a best-effort frame rather than throwing');
});

test('the deadline is bounded — it does not poll forever', async () => {
  const h = harness();
  const movedAt = h.now();
  let polls = 0;
  await pickSettledFrame({
    movedAt,
    latest: () => 'X',
    frameSince: () => { polls += 1; return undefined; },
    now: h.now, sleep: h.sleep,
    settleMs: 350, decodeMaxMs: 1200, pollMs: 80,
  });
  // budget = 350 + 1200 = 1550ms; at 80ms/poll that's ~20 polls max, not unbounded.
  assert.ok(polls > 0 && polls < 40, `bounded poll count, got ${polls}`);
});
