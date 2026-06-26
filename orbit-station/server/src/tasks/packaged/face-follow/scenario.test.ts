/**
 * faceFollow SCENARIO test — drives the task's real decision loop (stepFollow, the same
 * brain run() uses) across a SCRIPTED SCENE of face coordinates, tick by tick, with NO
 * process / WS / body. This is the "feed coords, watch what the task does" sim: it
 * asserts the stateful behaviour (lock persists, track→search→reacquire, pose converges)
 * that the per-function unit tests can't, AND prints a trace (run with --test-name-pattern
 * to eyeball it) so you can SEE the head's commanded pan/tilt follow a moving face.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepFollow, initialFollowState, type Face, type FollowState, type FollowStep,
} from './control.js';

const face = (cx: number, cy: number, size = 0.25, name: string | null = null): Face =>
  ({ name, confidence: 0.8, box: { x: cx - size / 2, y: cy - size / 2, w: size, h: size } });

/** Run a scripted scene (faces per tick) through the loop; return the per-tick trace. */
function runScene(scene: Face[][], cfg = { lostAfter: 4 } as Parameters<typeof stepFollow>[2], trace = false): FollowStep[] {
  let state: FollowState = initialFollowState();
  const out: FollowStep[] = [];
  scene.forEach((faces, i) => {
    const r = stepFollow(state, faces, cfg);
    state = r.state;
    out.push(r);
    if (trace) {
      const cmd = r.command ? `foot ${r.command.foot.toFixed(0)} neck ${r.command.neck.toFixed(0)}` : '—';
      console.log(`  t${String(i).padStart(2)} | ${r.status.padEnd(42)} | cmd ${cmd}`);
    }
  });
  return out;
}

const TRACE = process.env.FF_TRACE === '1';

// ── SCENE 1: a face drifts left→right; the head should track + pose converge ──────
test('SCENE: a face off-center → the command points the RIGHT direction (sign check)', () => {
  // DIRECTION/sign check only (scripted coords don't model feedback — convergence is the
  // closed-loop test's job). A face right of center → RIGHTWARD pan; a centered face → HOLD.
  // (Target smoothing means it eases toward center over ticks rather than snapping, so we
  // check the sign on a sustained off-center face, and the hold on a sustained centered one.)
  const right = runScene([[face(0.9, 0.5)], [face(0.9, 0.5)]], { lostAfter: 4 }, TRACE);
  assert.ok(right.every((t) => t.status.startsWith('tracking')), 'stays on the same person');
  assert.ok(right.every((t) => t.command === null || t.command.foot > 0), 'right face → only rightward pans');
  assert.ok(right.some((t) => t.command && t.command.foot > 0), 'does pan right');
  // a steadily-centered face → holds (no command), even through smoothing.
  const centered = runScene([[face(0.5, 0.5)], [face(0.5, 0.5)], [face(0.5, 0.5)]], { lostAfter: 4 }, TRACE);
  assert.ok(centered.every((t) => t.command === null), 'centered face → holds still (deadband)');
});

// ── SCENE 2: centered face → no command (deadband holds) ──────────────────────────
test('SCENE: a centered face produces NO movement (deadband)', () => {
  const scene = Array.from({ length: 3 }, () => [face(0.5, 0.5)]);
  const trace = runScene(scene, { lostAfter: 4 }, TRACE);
  assert.ok(trace.every((t) => t.command === null), 'no commands while centered');
  assert.ok(trace.every((t) => t.status.startsWith('tracking')));
});

// ── SCENE 3: face leaves → brief hold → SEARCH sweep from last-known ──────────────
test('SCENE: locked face leaves → HOLDS (lock-and-wait), then searches only after the long window', () => {
  // present 2 ticks, then gone for 6. NEW CONTRACT ("lock and wait"): once locked we HOLD
  // position indefinitely on a lost lock and do NOT sweep away — re-tracking the instant the
  // face returns. We give it a SHORT lostAfterCentered here so the eventual give-up→search
  // path still fires within the scene (default is ~indefinite by design).
  const scene = [[face(0.7, 0.5)], [face(0.8, 0.5)], [], [], [], [], [], []];
  if (TRACE) console.log('\nSCENE 3 — locked face leaves: holds, then (after the window) searches:');
  const trace = runScene(scene, { lostAfter: 4, lostAfterCentered: 4 }, TRACE);
  assert.ok(trace[0]!.status.startsWith('tracking'));
  // while holding: NO command (doesn't move on) and the status says it's holding/waiting.
  assert.ok(trace[2]!.command === null && /holding|missing/.test(trace[2]!.status), 'holds, does not move on');
  // it NEVER swept before the hold window elapsed (no search command during the hold).
  const earlySearchMove = trace.slice(0, 5).some((t) => t.status.startsWith('searching') && t.command !== null);
  assert.ok(!earlySearchMove, 'does not sweep away while holding on the lost lock');
  // after the (short, test-only) window: it does eventually search + sweep.
  const searching = trace.filter((t) => t.status.startsWith('searching'));
  assert.ok(searching.length > 0, 'eventually searches once the long hold window elapses');
});

// ── SCENE 4: two people — LOCK holds on one, no oscillation ───────────────────────
test('SCENE: two people present — locks on one and does NOT flip-flop', () => {
  // left person steady at 0.3; a slightly-bigger right person at 0.7 appears from t1.
  const L = face(0.3, 0.5, 0.25);
  const R = face(0.7, 0.5, 0.27); // marginally bigger, NOT decisively (<1.4x)
  const scene = [[L], [L, R], [L, R], [L, R], [L, R]];
  if (TRACE) console.log('\nSCENE 4 — two people, lock holds:');
  const trace = runScene(scene, { lostAfter: 4 }, TRACE);
  // locked on left (first seen); every tick's target stays left-of-center → pan stays ≤ 0-ish
  assert.ok(trace.every((t) => t.state.lock!.at.x < 0.5), 'kept the lock on the left person');
  // pan never swings to the right person's side (no flip-flop)
  assert.ok(trace.every((t) => t.state.pose.foot <= 1), 'never panned toward the right person');
});

// ── SCENE 5: named target — follows only them, ignores a bigger stranger ──────────
test('SCENE: named target followed; a bigger unnamed face is ignored', () => {
  const guru = face(0.75, 0.5, 0.2, 'guru');
  const stranger = face(0.25, 0.5, 0.5, null); // much bigger + on the other side
  const scene = [[guru, stranger], [guru, stranger]];
  if (TRACE) console.log('\nSCENE 5 — named target (guru) amid a bigger stranger:');
  const trace = runScene(scene, { target: 'guru', lostAfter: 4 }, TRACE);
  assert.ok(trace.every((t) => /tracking guru/.test(t.status)), 'always tracking guru');
  assert.ok(trace.every((t) => t.state.lock!.at.x > 0.5), 'anchored on guru (right), not the stranger');
});

// ── SCENE 6: named target absent → searches for them (ignores others) ─────────────
test('SCENE: named target not present → searches (does not lock onto a stranger)', () => {
  const stranger = face(0.5, 0.5, 0.4, 'sam');
  const scene = Array.from({ length: 6 }, () => [stranger]);
  const trace = runScene(scene, { target: 'guru', lostAfter: 4 }, TRACE);
  assert.ok(trace.every((t) => !t.status.startsWith('tracking')), 'never tracks the wrong person');
  assert.ok(trace.some((t) => t.status.startsWith('searching')), 'searches for the absent target');
});

// ── SCENE 7: SALIENT — after the long hold window expires, re-pick the NEXT salient face ──
test('SCENE (salient): A leaves; after the hold window it gives up + commits to the next person', () => {
  // NEW CONTRACT: salient mode HOLDS+waits for A (lock-and-wait), not immediately switching.
  // Only after lostAfterCentered (short here for the test) does it drop A and re-pick B.
  const a = face(0.3, 0.5, 0.25);          // person A, followed first
  const b = face(0.7, 0.5, 0.25, 'bob');   // person B appears only after A is gone
  const scene = [[a], [a], [], [], [], [], [], [b], [b]]; // A 2t, gone 5t, then B
  if (TRACE) console.log('\nSCENE 7 — salient: A leaves, hold, then commit to B:');
  const trace = runScene(scene, { lostAfter: 4, lostAfterCentered: 4 }, TRACE);
  // while A is gone but within the hold window: it HOLDS (no re-pick, no sweep-away).
  assert.ok(trace[3]!.command === null, 'holds on absent A during the wait window (does not move on)');
  const last = trace[trace.length - 1]!;
  assert.ok(last.status.startsWith('tracking'), 'tracking again');
  assert.ok(last.state.lock!.at.x > 0.5, 'after the window, committed to B (right), not stuck on absent A');
});

// ── SCENE 8: SALIENT — a newcomer does NOT steal the lock while A is still here ────
test('SCENE (salient): a newcomer does not steal the lock from the still-present person', () => {
  const a = face(0.3, 0.5, 0.25);   // A, locked first
  const big = face(0.8, 0.5, 0.45); // a BIGGER newcomer arrives at t1
  const scene = [[a], [a, big], [a, big], [a, big]];
  const trace = runScene(scene, { lostAfter: 4 }, TRACE);
  assert.ok(trace.every((t) => t.state.lock!.at.x < 0.5), 'kept following A, ignored the bigger newcomer');
});

// ── SCENE 9: ANTI-TWITCH — a jittering box (still person) doesn't make it twitch ──
test('SCENE (anti-twitch): box jitter on a ~centered face is damped, not chased', () => {
  // a still person whose detected box CENTER wobbles ±0.05 around 0.5 each tick (face-api
  // jitter). With smoothing + deadband it should mostly HOLD (few/no commands), not issue
  // a correction every tick.
  const jitter = [0.5, 0.55, 0.46, 0.54, 0.47, 0.53, 0.48, 0.52].map((x) => [face(x, 0.5)]);
  if (TRACE) console.log('\nSCENE 9 — jittery still face (anti-twitch):');
  const trace = runScene(jitter, { lostAfter: 4 }, TRACE);
  const moves = trace.filter((t) => t.command !== null).length;
  assert.ok(moves <= 2, `mostly holds despite jitter (${moves}/${trace.length} ticks moved)`);
  assert.ok(trace.every((t) => t.status.startsWith('tracking')), 'stays locked through jitter');
});
