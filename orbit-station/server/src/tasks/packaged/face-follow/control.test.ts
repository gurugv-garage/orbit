/**
 * faceFollow control logic — target selection (named/salient + the continuity LOCK that
 * stops crowd oscillation), the ADAPTIVE trial-and-adjust controller (sign-only + step
 * adaptation, no mapping), and the search sweep. Pure; no body, no task.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTarget, adaptiveMove, sweepStep, saliency, center, stepFollow, initialFollowState,
  type Face, type Pose, FOOT_LIMIT, NECK_MIN, NECK_MAX,
} from './control.js';
import { adaptAxis, initAxis, DEFAULT_AXIS } from './adaptive.js';

/** A face at normalized center (cx,cy) with a given size + optional name. */
const face = (cx: number, cy: number, size = 0.2, name: string | null = null, confidence = 0.8): Face =>
  ({ name, confidence, box: { x: cx - size / 2, y: cy - size / 2, w: size, h: size } });

// ── saliency / center ────────────────────────────────────────────────────────

test('center + saliency: bigger and more central is more salient', () => {
  assert.deepEqual(center(face(0.5, 0.5, 0.2)), { x: 0.5, y: 0.5 });
  const big = face(0.5, 0.5, 0.4);     // big + centered
  const small = face(0.1, 0.1, 0.1);   // small + corner
  assert.ok(saliency(big) > saliency(small));
});

test('center PREFERS the eye-midpoint anchor when present (the neck-dive fix)', () => {
  // box geometric center is (0.5, 0.7) — reads LOW (the box sags onto the jaw); the
  // eye midpoint is the higher, stable anchor. center() must steer on the eyes.
  const f: Face = { name: null, confidence: 0.8, box: { x: 0.4, y: 0.6, w: 0.2, h: 0.2 }, eyeMid: { x: 0.52, y: 0.45 } };
  assert.deepEqual(center(f), { x: 0.52, y: 0.45 });
  // without eyeMid → fall back to the box center (0.5, 0.7).
  const { eyeMid: _drop, ...noEyes } = f;
  assert.deepEqual(center(noEyes), { x: 0.5, y: 0.7 });
});

// ── pickTarget: salient default ────────────────────────────────────────────────

test('no faces → null', () => {
  assert.equal(pickTarget([]), null);
});

test('most-salient chosen when no lock + no target', () => {
  const r = pickTarget([face(0.1, 0.5, 0.1), face(0.5, 0.5, 0.4)]);
  assert.ok(r);
  assert.equal(r!.at.x, 0.5); // the big central one
});

// ── pickTarget: named target ─────────────────────────────────────────────────

test('named target followed; others ignored', () => {
  const r = pickTarget([face(0.2, 0.5, 0.4, null), face(0.8, 0.5, 0.1, 'guru')], { target: 'guru' });
  assert.equal(r!.face.name, 'guru');
  assert.ok(r!.at.x > 0.7); // guru's position, even though the unnamed face is bigger
});

test('named target absent → null (caller searches), even with other faces present', () => {
  assert.equal(pickTarget([face(0.5, 0.5, 0.4, 'sam')], { target: 'guru' }), null);
});

test('named match is case-insensitive', () => {
  const r = pickTarget([face(0.5, 0.5, 0.2, 'Guru')], { target: 'guru' });
  assert.equal(r!.face.name, 'Guru');
});

// ── pickTarget: the continuity LOCK (anti-oscillation) ──────────────────────────

test('LOCK: keeps following the locked person even when another is somewhat more salient', () => {
  // locked on the left person; a marginally bigger person appears on the right —
  // NOT decisively more salient (< 1.4x), so the lock holds.
  const left = face(0.2, 0.5, 0.2);
  const right = face(0.8, 0.5, 0.21); // barely bigger; saliency ratio well under the 1.4 margin
  const r = pickTarget([left, right], { lockAt: { x: 0.2, y: 0.5 } });
  assert.ok(r!.at.x < 0.4, 'stayed on the locked (left) person');
});

test('LOCK: switches when a challenger is DECISIVELY more salient', () => {
  const left = face(0.2, 0.5, 0.1);   // locked but now small/far
  const right = face(0.8, 0.5, 0.5);  // hugely more salient
  const r = pickTarget([left, right], { lockAt: { x: 0.2, y: 0.5 } });
  assert.ok(r!.at.x > 0.6, 'switched to the decisively-more-salient person');
});

test('LOCK: if the locked person is gone (no face near the anchor), re-pick most salient', () => {
  // anchor far from the only face → not the same person → re-pick.
  const r = pickTarget([face(0.9, 0.9, 0.3)], { lockAt: { x: 0.1, y: 0.1 } });
  assert.ok(r); assert.ok(r!.at.x > 0.7);
});

// ── adaptAxis: STEP-AND-SETTLE (small fixed step toward the sign, then settle) ──────
// The reliably-implementable controller: trusts ONLY sign + presence, never the laggy
// position magnitude, never reasons about why a face vanished. Small step can't fling the
// camera past the person; the settle wait lets a FRESH look land before the next move.

test('CENTERED (within deadband) → hold (delta 0), clears settle', () => {
  const r = adaptAxis({ cooldown: 1 }, 0.02, DEFAULT_AXIS); // |err| 0.02 < deadband 0.10
  assert.equal(r.delta, 0, 'holds when centered');
  assert.equal(r.state.cooldown, 0, 'centered clears any pending settle');
});

test('SIGN only: err>0 (face right/low) → +step; err<0 → −step; magnitude is the FIXED step', () => {
  const right = adaptAxis(initAxis(), 0.3, DEFAULT_AXIS);
  assert.equal(right.delta, DEFAULT_AXIS.step, 'positive error → +fixed step (not proportional)');
  const left = adaptAxis(initAxis(), -0.3, DEFAULT_AXIS);
  assert.equal(left.delta, -DEFAULT_AXIS.step, 'negative error → −fixed step');
  // a HUGE error gives the SAME small step as a small one — never flings (the overshoot fix).
  const huge = adaptAxis(initAxis(), 0.49, DEFAULT_AXIS);
  assert.equal(Math.abs(huge.delta), DEFAULT_AXIS.step, 'far-off face still moves only one small step');
});

test('SETTLE: after a move it HOLDS for settleTicks (no overshoot on a stale read)', () => {
  const cfg = { deadband: 0.10, step: 5, settleTicks: 2 };
  // move once → arms a 2-tick settle.
  const m = adaptAxis(initAxis(), 0.3, cfg);
  assert.equal(m.delta, 5, 'first move steps');
  assert.equal(m.state.cooldown, 2, 'arms the settle');
  // next two ticks: even with the (possibly STALE) error still showing off-center, HOLD.
  const s1 = adaptAxis(m.state, 0.3, cfg);
  assert.equal(s1.delta, 0, 'settling — holds tick 1 (ignores the stale read)');
  const s2 = adaptAxis(s1.state, 0.3, cfg);
  assert.equal(s2.delta, 0, 'settling — holds tick 2');
  // settle elapsed → free to move again on a now-fresh look.
  const m2 = adaptAxis(s2.state, 0.3, cfg);
  assert.equal(m2.delta, 5, 'moves again once the settle elapsed');
});

test('CONVERGES by small steps without flinging: a fixed off-center face is approached, not overshot', () => {
  // closed-ish: each move reduces the (modelled) error by the step mapped through a gain; the
  // point is it takes MANY small steps and never reverses hard (no fling). settleTicks=0 here
  // to test the stepping cadence alone.
  const cfg = { deadband: 0.10, step: 5, settleTicks: 0 };
  let st = initAxis();
  const deltas: number[] = [];
  let err = 0.45;
  for (let i = 0; i < 10 && Math.abs(err) >= cfg.deadband; i++) {
    const r = adaptAxis(st, err, cfg); st = r.state;
    deltas.push(r.delta);
    err -= r.delta * 0.02; // crude world: 5° step closes ~0.1 of normalized error
  }
  assert.ok(deltas.every((d) => Math.abs(d) <= cfg.step), 'every move is at most one small step (never flings)');
  assert.ok(Math.abs(err) < 0.45, 'error reduced toward center');
});

// ── adaptiveMove: the pose-level wrapper (sign convention + clamping) ───────────

const C: Pose = { foot: 0, neck: 0 };

test('adaptiveMove SIGN: face RIGHT (x>0.5) → foot +; face LEFT → foot −', () => {
  const right = adaptiveMove(C, initAxis(), initAxis(), { x: 0.9, y: 0.5 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.ok(right.pose && right.pose.foot > 0, 'pans right (foot +)');
  const left = adaptiveMove(C, initAxis(), initAxis(), { x: 0.1, y: 0.5 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.ok(left.pose && left.pose.foot < 0, 'pans left (foot −)');
});

test('adaptiveMove SIGN: face HIGH (y<0.5) → neck − (up); LOW → neck + (down)', () => {
  const up = adaptiveMove(C, initAxis(), initAxis(), { x: 0.5, y: 0.1 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.ok(up.pose && up.pose.neck < 0, 'tilts up (neck −)');
  const down = adaptiveMove(C, initAxis(), initAxis(), { x: 0.5, y: 0.9 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.ok(down.pose && down.pose.neck > 0, 'tilts down (neck +)');
});

test('adaptiveMove: centered → null pose (HOLD STILL)', () => {
  const r = adaptiveMove(C, initAxis(), initAxis(), { x: 0.5, y: 0.5 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.equal(r.pose, null, 'no command when centered');
});

test('adaptiveMove clamps to limits (never past foot ±90 / neck −60..+35)', () => {
  // at the foot/neck max, a face pulling further right/down → clamped → no change → null pose.
  const atMax: Pose = { foot: FOOT_LIMIT, neck: NECK_MAX };
  const r = adaptiveMove(atMax, initAxis(), initAxis(), { x: 1.0, y: 1.0 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.equal(r.pose, null, 'at the limit, pushing further is a no-op hold');
  const atMin: Pose = { foot: -FOOT_LIMIT, neck: NECK_MIN };
  const lo = adaptiveMove(atMin, initAxis(), initAxis(), { x: 0.0, y: 0.0 }, DEFAULT_AXIS, DEFAULT_AXIS);
  assert.equal(lo.pose, null);
});

// ── sweepStep: search ─────────────────────────────────────────────────────────

test('sweep pans outward and reverses at the limit', () => {
  let p: Pose = { foot: FOOT_LIMIT - 5, neck: 0 }; let dir: 1 | -1 = 1;
  let s = sweepStep(p, dir); // would exceed +90 → clamp + reverse
  assert.equal(s.pose.foot, FOOT_LIMIT);
  assert.equal(s.dir, -1);
  s = sweepStep(s.pose, s.dir); // now panning back
  assert.ok(s.pose.foot < FOOT_LIMIT);
});

test('sweep from last-known position (caller seeds `from`) starts there, not zero', () => {
  const s = sweepStep({ foot: 40, neck: 0 }, 1, 15);
  assert.equal(s.pose.foot, 55); // 40 + 15, not from 0
});

// ── YIELD + COOLDOWN: faceFollow is a deferring behaviour, not an exclusive owner ────────

const T0 = 1_000_000; // a fixed injected clock so the cooldown is deterministic
const cfgY = { lostAfter: 8, cooldownMs: 60_000 };

test('COLD START: no foreign mover → follows immediately, never yields', () => {
  const s0 = initialFollowState();
  const r = stepFollow(s0, [face(0.9, 0.5)], cfgY, { now: T0, foreignMover: false });
  assert.notEqual(r.state.mode, 'yielded');
  assert.ok(r.status.startsWith('tracking'), 'cold start tracks at once, no cooldown');
});

test('YIELD: a FOREIGN mover takes the body → stop commanding + start the cooldown', () => {
  const s0 = { ...initialFollowState(), lock: { name: null, at: { x: 0.5, y: 0.5 }, centered: true } };
  const r = stepFollow(s0, [face(0.9, 0.5)], cfgY, { now: T0, foreignMover: true });
  assert.equal(r.state.mode, 'yielded');
  assert.equal(r.command, null, 'issues NO command while yielding (does not fight the other mover)');
  assert.equal(r.state.cooldownUntil, T0 + 60_000, 'cooldown armed for cfg.cooldownMs');
  assert.deepEqual(r.state.lock, s0.lock, 'keeps the lock so it resumes on the same person');
});

test('COOLDOWN: holds (no commands) until it elapses, even with a face dead-ahead', () => {
  let st = stepFollow(initialFollowState(), [], cfgY, { now: T0, foreignMover: true }).state;
  // mid-cooldown: a perfectly trackable face is present, but we must still hold.
  const mid = stepFollow(st, [face(0.9, 0.5)], cfgY, { now: T0 + 30_000, foreignMover: false });
  assert.equal(mid.state.mode, 'yielded');
  assert.equal(mid.command, null, 'still yielding mid-cooldown');
  st = mid.state;
  // just before the end — still holding.
  const almost = stepFollow(st, [face(0.9, 0.5)], cfgY, { now: T0 + 59_000, foreignMover: false });
  assert.equal(almost.command, null);
});

test('RESUME: once the cooldown elapses, it follows again', () => {
  const yielded = stepFollow(initialFollowState(), [], cfgY, { now: T0, foreignMover: true }).state;
  const back = stepFollow(yielded, [face(0.9, 0.5)], cfgY, { now: T0 + 60_001, foreignMover: false });
  assert.notEqual(back.state.mode, 'yielded');
  assert.equal(back.state.cooldownUntil, 0, 'cooldown cleared on resume');
  assert.ok(back.status.startsWith('tracking'), 'back to following after the cooldown');
});

test('RE-YIELD: a foreign mover DURING cooldown restarts the full cooldown window', () => {
  const first = stepFollow(initialFollowState(), [], cfgY, { now: T0, foreignMover: true }).state;
  const again = stepFollow(first, [], cfgY, { now: T0 + 30_000, foreignMover: true });
  assert.equal(again.state.cooldownUntil, T0 + 30_000 + 60_000, 'cooldown re-armed from the new foreign move');
});

test('sweep UN-STICKS a saturated neck: a neck left at the down-limit eases back to home', () => {
  // the live bug: after chasing a low/close face the neck pins at NECK_MAX (looking down),
  // then the sweep scans the FLOOR. Each sweep step must ease the neck toward home (0).
  let p: Pose = { foot: 10, neck: NECK_MAX }; let dir: 1 | -1 = 1;
  const before = p.neck;
  for (let i = 0; i < 4; i++) { const s = sweepStep(p, dir, 8, 0); p = s.pose; dir = s.dir; }
  assert.ok(p.neck < before, `neck eased up off the down-limit (${before}° → ${p.neck.toFixed(1)}°)`);
  assert.ok(Math.abs(p.neck) < 6, `neck reached ~search-home after a few steps (${p.neck.toFixed(1)}°)`);
});
