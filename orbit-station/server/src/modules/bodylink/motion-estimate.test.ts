/**
 * MotionExecutor.estimateSequenceMs — the paced estimate a lease-holding caller (the task
 * `gesture` capability) trusts to hold the body through a fire-and-forget choreography.
 * Proves the two properties the review demanded (2026-07-05): fast authored durations are
 * STRETCHED to the comfort/velocity floor (the authored sum under-counts), and generous
 * authored durations pass through unchanged. Pose rolls across steps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionExecutor } from './motion.js';
import type { MoveStep } from '../brain/schemas.js';

const fakeBus = { publish: () => {}, on: () => {} } as never;
const fakeDir = { resolveCap: () => undefined } as never;
const mk = () => new MotionExecutor(fakeBus, fakeDir);

test('fast big-travel steps are stretched past their authored duration (comfort floor)', () => {
  const m = mk();
  // an "excited"-style vibrate: ±15° foot swings at 80 ms each. From center, step 1 is
  // 15° (~167 µs → comfort ≈ 112 ms) and each subsequent swing is 30° (~333 µs → ≈ 223 ms).
  const steps: MoveStep[] = Array.from({ length: 6 }, (_, i) => ({
    parts: [{ part: 'foot', degrees: i % 2 === 0 ? 15 : -15 }], duration_ms: 80,
  })) as MoveStep[];
  const authored = 6 * 80;
  const est = m.estimateSequenceMs('d1', steps);
  assert.ok(est > authored * 1.8, `estimate ${est}ms must far exceed the authored ${authored}ms`);
  m.shutdown();
});

test('generously-authored steps pass through at their authored duration + waits', () => {
  const m = mk();
  const steps: MoveStep[] = [
    { parts: [{ part: 'foot', degrees: -35 }], duration_ms: 1800, wait_ms: 700 },
    { parts: [{ part: 'foot', degrees: 35 }], duration_ms: 2600, wait_ms: 700 },
    { parts: [{ part: 'foot', degrees: 0 }], duration_ms: 1400 },
  ] as MoveStep[];
  const authored = 1800 + 700 + 2600 + 700 + 1400;
  assert.equal(m.estimateSequenceMs('d1', steps), authored, 'slow bits are not inflated');
  m.shutdown();
});

test('pose ROLLS across steps — the second swing is measured from the first target', () => {
  const m = mk();
  // two identical fast steps to the same absolute target: step 2 has ZERO travel from
  // step 1's target, so it must NOT be stretched (rolling pose, not the live pose twice).
  const steps: MoveStep[] = [
    { parts: [{ part: 'foot', degrees: 30 }], duration_ms: 100 },
    { parts: [{ part: 'foot', degrees: 30 }], duration_ms: 100 },
  ] as MoveStep[];
  const est = m.estimateSequenceMs('d1', steps);
  // step 1 stretches (30° from center); step 2 is zero-travel → stays 100 ms.
  const step1 = m.estimateSequenceMs('d1', steps.slice(0, 1));
  assert.equal(est, step1 + 100, 'zero-travel follow-up is not re-stretched');
  m.shutdown();
});
