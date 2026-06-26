/**
 * faceFollow CLOSED-LOOP sim — the convergence/stability test the scripted-coords
 * scenario test can't do. It models the missing feedback: as the head PANS toward a
 * face, that face moves toward frame-center. So we can prove the controller actually
 * SETTLES on a face (and doesn't overshoot/oscillate), not just that its first command
 * points the right way.
 *
 * World model: a face has a fixed world angle (Wx pan°, Wy tilt°) relative to room-
 * center. With the head at pose {foot, neck}, the camera SEES it at:
 *     apparent_x = 0.5 + (Wx − foot) / FOV_X      (clamped/visible only within FOV)
 *     apparent_y = 0.5 + (Wy − neck) / FOV_Y      (note: neck− = up, world up = Wy−)
 * When foot→Wx and neck→Wy, the face is centered (apparent 0.5,0.5) → error 0 → settle.
 *
 * This validates the GAINS (panGain/tiltGain/maxStep/deadband in control.ts) produce a
 * stable lock — the thing you'd otherwise only learn on the real body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepFollow, initialFollowState, type Face, type FollowState, type Pose } from './control.js';

/** Horizontal/vertical field of view (deg) the camera spans across the 0..1 frame. A
 *  phone front cam is ~60° H; pick round numbers — the test asserts behaviour, not optics. */
const FOV_X = 60;
const FOV_Y = 45;

interface WorldFace { wx: number; wy: number; size?: number; name?: string | null }

/** Project a world face into the camera frame given the head pose. Returns the Face
 *  (with box) IF it's within the FOV, else null (out of view → recognize sees nothing). */
function apparent(w: WorldFace, pose: Pose): Face | null {
  const ax = 0.5 + (w.wx - pose.foot) / FOV_X;
  const ay = 0.5 + (w.wy - pose.neck) / FOV_Y;
  if (ax < 0 || ax > 1 || ay < 0 || ay > 1) return null; // outside the frame
  const size = w.size ?? 0.25;
  return { name: w.name ?? null, confidence: 0.8, box: { x: ax - size / 2, y: ay - size / 2, w: size, h: size } };
}

/** Run the closed loop for N ticks against a fixed world; return the pose + apparent-error trace. */
function runClosed(world: WorldFace[], ticks: number, opts: { target?: string } = {}) {
  let state: FollowState = initialFollowState();
  const trace: Array<{ pose: Pose; err: number | null; status: string }> = [];
  for (let i = 0; i < ticks; i++) {
    const seen = world.map((w) => apparent(w, state.pose)).filter((f): f is Face => f != null);
    const r = stepFollow(state, seen, { target: opts.target, lostAfter: 4 });
    state = r.state;
    // apparent error of the LOCKED face (if any) AFTER applying the command this tick
    const lockedWorld = opts.target
      ? world.find((w) => w.name?.toLowerCase() === opts.target!.toLowerCase())
      : world[0];
    const ap = lockedWorld ? apparent(lockedWorld, state.pose) : null;
    const err = ap ? Math.hypot((ap.box.x + ap.box.w / 2) - 0.5, (ap.box.y + ap.box.h / 2) - 0.5) : null;
    trace.push({ pose: state.pose, err, status: r.status });
    if (process.env.FF_TRACE === '1') {
      console.log(`  t${String(i).padStart(2)} | foot ${state.pose.foot.toFixed(0).padStart(4)} neck ${state.pose.neck.toFixed(0).padStart(4)} | err ${err == null ? '   —' : err.toFixed(3)} | ${r.status}`);
    }
  }
  return trace;
}

test('CONVERGES: an off-center face is centered within a few ticks and SETTLES', () => {
  if (process.env.FF_TRACE === '1') console.log('\nCLOSED-LOOP — face at pan +40°, tilt -20°:');
  const trace = runClosed([{ wx: 40, wy: -20 }], 15);
  const final = trace[trace.length - 1]!;
  // settled WITHIN THE DEADBAND (gentle tuning holds at ~deadband, doesn't chase to 0),
  // and the head ended up roughly pointing at the face.
  assert.ok(final.err != null && final.err <= 0.16, `centered within deadband (final err ${final.err})`);
  assert.ok(Math.abs(final.pose.foot - 40) < 12, `head pans to the face (foot ${final.pose.foot})`);
  assert.ok(Math.abs(final.pose.neck - (-20)) < 12, `head tilts to the face (neck ${final.pose.neck})`);
});

test('NO OSCILLATION: once settled, it HOLDS STILL (no hunting around the face)', () => {
  const trace = runClosed([{ wx: 30, wy: 0 }], 20); // wy:0 → vertically centered too
  // the KEY property: once settled, the pose STOPS changing ENTIRELY on BOTH axes (the
  // head holds, looking at the person — "stay on me until I move"). No micro-jitter.
  const tail = trace.slice(10);
  const footSwing = Math.max(...tail.map((t) => t.pose.foot)) - Math.min(...tail.map((t) => t.pose.foot));
  const neckSwing = Math.max(...tail.map((t) => t.pose.neck)) - Math.min(...tail.map((t) => t.pose.neck));
  assert.equal(footSwing, 0, `pan fully settled — no jitter (swing ${footSwing}°)`);
  assert.equal(neckSwing, 0, `tilt fully settled — no jitter (swing ${neckSwing}°)`);
  assert.ok(Math.max(...tail.map((t) => t.err ?? 1)) <= 0.16, 'centered + held');
});

test('FOLLOWS A MOVING FACE at a reasonable pace (within the gentle pan rate)', () => {
  // A person moving ~2°/tick — WITHIN the head's gentle pan capability (maxPanStep 3°).
  // The head should keep them in view with bounded lag. NOTE: with the gentle tuning, a
  // FAST mover (> pan rate) will lag and could be lost — an accepted tradeoff (gentle vs.
  // fast-tracking); smooth fast-tracking is where frame-timestamp motion-compensation
  // (latency approach A) would be needed. Tracked here at a human, seated-fidget pace.
  let state: FollowState = initialFollowState();
  let wx = 0; const errs: number[] = [];
  for (let i = 0; i < 25; i++) {
    wx = Math.min(50, wx + 2); // ~2°/tick — within the 3°/tick pan rate
    const seen = [apparent({ wx, wy: 0 }, state.pose)].filter((f): f is Face => f != null);
    const r = stepFollow(state, seen, { lostAfter: 8 });
    state = r.state;
    const ap = apparent({ wx, wy: 0 }, state.pose);
    if (ap) errs.push(Math.abs((ap.box.x + ap.box.w / 2) - 0.5));
  }
  assert.ok(errs.length >= 23, 'kept the moving face in view');
  assert.ok(Math.max(...errs.slice(8)) < 0.25, `lag bounded at a reasonable pace (max ${Math.max(...errs.slice(8)).toFixed(2)})`);
});

// ── THE USER'S NAMED CASES — the robustness properties that matter most ─────────
// "It should be a reliable algorithm that can run for long periods... holding position.
//  Even if I jump away somewhere else, it just follows the algorithm: nobody's in the
//  frame, so I'll make slightly large sweeps to find somebody again. That's all."

/** Closed loop over a world that can CHANGE per tick (worldAt(i) → faces present then). */
function runDynamic(worldAt: (i: number) => WorldFace[], ticks: number, opts: { target?: string; lostAfter?: number; lostAfterCentered?: number } = {}) {
  let state: FollowState = initialFollowState();
  const trace: Array<{ pose: Pose; status: string; sawFace: boolean }> = [];
  for (let i = 0; i < ticks; i++) {
    const world = worldAt(i);
    const seen = world.map((w) => apparent(w, state.pose)).filter((f): f is Face => f != null);
    const r = stepFollow(state, seen, { target: opts.target, lostAfter: opts.lostAfter ?? 4, lostAfterCentered: opts.lostAfterCentered });
    state = r.state;
    trace.push({ pose: state.pose, status: r.status, sawFace: seen.length > 0 });
    if (process.env.FF_TRACE === '1') {
      console.log(`  t${String(i).padStart(2)} | foot ${state.pose.foot.toFixed(0).padStart(4)} neck ${state.pose.neck.toFixed(0).padStart(4)} | saw ${seen.length} | ${r.status}`);
    }
  }
  return trace;
}

test("USER CASE — stationary person, centered: HOLDS FOREVER (no drift over a long run)", () => {
  // Person dead-centered; run a LONG time. Once centered the head must never move again.
  const trace = runDynamic(() => [{ wx: 0, wy: 0 }], 60);
  const tail = trace.slice(20); // well after it has settled
  const footSwing = Math.max(...tail.map((t) => t.pose.foot)) - Math.min(...tail.map((t) => t.pose.foot));
  const neckSwing = Math.max(...tail.map((t) => t.pose.neck)) - Math.min(...tail.map((t) => t.pose.neck));
  assert.equal(footSwing, 0, `pan dead-still over 40 ticks (swing ${footSwing}°)`);
  assert.equal(neckSwing, 0, `tilt dead-still over 40 ticks (swing ${neckSwing}°)`);
  assert.ok(tail.every((t) => t.status.startsWith('tracking')), 'stays in track the whole time');
});

test("USER CASE — person JUMPS AWAY (out of view): it sweeps and RE-FINDS them elsewhere", () => {
  // ticks 0..9: person front-center (gets locked + centered).
  // ticks 10..: person has jumped to +70° (out of the centered FOV) → must sweep to re-find.
  // We were CENTERED, so the asymmetric grace holds longer before sweeping (lostAfterCentered);
  // set a short one here so the test exercises the eventual sweep within its tick budget.
  const worldAt = (i: number): WorldFace[] => (i < 10 ? [{ wx: 0, wy: 0 }] : [{ wx: 70, wy: 0 }]);
  const trace = runDynamic(worldAt, 55, { lostAfter: 4, lostAfterCentered: 6 });
  // after the jump it must SEARCH (the person is gone from view)...
  assert.ok(trace.slice(11).some((t) => t.status.startsWith('searching')), 'sweeps to look after they vanish');
  // ...and eventually re-find + track them at the new location.
  const end = trace.slice(-5);
  assert.ok(end.some((t) => t.status.startsWith('tracking') && t.sawFace), 're-finds + tracks at the new spot');
  assert.ok(Math.abs(trace[trace.length - 1]!.pose.foot - 70) < 18, `head ends pointed near the new location (foot ${trace[trace.length - 1]!.pose.foot})`);
});

test("USER CASE — CENTERED person briefly drops out (detection gap): HOLDS on them, does NOT pan away", () => {
  // The live bug: MLKit lost a still, centered face for ~6s; the head gave up and swept off.
  // Here: person dead-center, then detection BLANKS for 10 ticks (a dropout), then returns.
  // With the long centered-grace the head must HOLD its pose and keep looking — never sweep.
  const BLANK = new Set(Array.from({ length: 10 }, (_, k) => k + 8)); // ticks 8..17 blank
  const worldAt = (i: number): WorldFace[] => (BLANK.has(i) ? [] : [{ wx: 0, wy: 0 }]);
  const trace = runDynamic(worldAt, 30, { lostAfter: 4, lostAfterCentered: 20 });
  // through the whole dropout it must NOT enter search...
  assert.ok(!trace.some((t) => t.status.startsWith('searching')), 'never sweeps off a centered person during a detection gap');
  // ...the head holds where it was (no wandering), and re-locks when detection returns.
  const duringGap = trace.slice(10, 17);
  const footSwing = Math.max(...duringGap.map((t) => t.pose.foot)) - Math.min(...duringGap.map((t) => t.pose.foot));
  assert.equal(footSwing, 0, `head holds still through the gap (swing ${footSwing}°)`);
  assert.ok(trace.slice(-3).some((t) => t.status.startsWith('tracking') && t.sawFace), 're-locks when the face reappears');
});

test("USER CASE — empty room: SWEEPS indefinitely, never gives up, never errors", () => {
  // Nobody ever appears. It must just keep sweeping the range forever (a stable forever-loop).
  const trace = runDynamic(() => [], 50, { lostAfter: 4 });
  assert.ok(trace.slice(-10).every((t) => t.status.startsWith('searching') || t.status.includes('missing')),
    'keeps searching when the room is empty');
  // and it actually MOVES across the range (covers ground), reversing at the edges — not stuck.
  const feet = trace.map((t) => t.pose.foot);
  assert.ok(Math.max(...feet) - Math.min(...feet) > 30, 'sweep actually scans a range (not stuck in place)');
});

test('REACQUIRES via search: face out of FOV → sweep finds it → re-locks + centers', () => {
  // face at +75° pan — initially OUTSIDE the ±30° the centered head can see (FOV/2=30),
  // so recognize sees nothing → search sweeps → eventually the sweep points near it →
  // it enters frame → track + center.
  if (process.env.FF_TRACE === '1') console.log('\nCLOSED-LOOP — face at +75° (needs search to find):');
  const trace = runClosed([{ wx: 75, wy: 0 }], 30);
  // early ticks: not visible → searching; later: found + tracking + centered.
  assert.ok(trace.slice(0, 5).some((t) => t.status.startsWith('searching')), 'searches when the face is out of view');
  const final = trace[trace.length - 1]!;
  assert.ok(final.status.startsWith('tracking'), 'ends up tracking once found');
  assert.ok(final.err != null && final.err < 0.1, `re-centered after reacquire (err ${final.err})`);
});
