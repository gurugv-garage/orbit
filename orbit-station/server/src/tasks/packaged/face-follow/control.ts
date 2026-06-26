/**
 * faceFollow control logic — pure, testable, no task/transport
 * (docs/decision-traces/facefollow-and-actuator-lease.md). Kept separate from task.ts
 * (which runTask()s at import) so target-selection + the controller are unit-testable.
 *
 * The loop the task runs: recognize() → faces[] → pickTarget (named/salient, LOCKED by
 * continuity) → ADAPTIVE trial-and-adjust per axis (adaptive.ts — NO degrees↔pixels
 * mapping assumed; it discovers the machine's responsiveness live). The search/reacquire
 * state machine lives here too so it's testable without a body.
 */
import { adaptAxis, initAxis, type AxisState, type AxisCfg, DEFAULT_AXIS } from './adaptive.js';

/** A face from the `face-track` capability (the on-device `perceive` stream). */
export interface Face {
  name: string | null;
  confidence: number;
  box: { x: number; y: number; w: number; h: number }; // normalized 0..1
  /** EYE-MIDPOINT anchor (perceive §7), 0..1 — the midpoint of the eyes, the STABLE
   *  centering point. Present when both eyes were visible; absent ⇒ use the box center.
   *  The box geometric center reads low (the box sags onto the jaw), which made the neck
   *  dive; centering on the eyes is the fix. */
  eyeMid?: { x: number; y: number };
}

/** Body pose — absolute angles within DEGREE_LIMITS (foot ±90 pan, neck −60..+35 tilt). */
export interface Pose { foot: number; neck: number }

export const FOOT_LIMIT = 90;
export const NECK_MIN = -60;
export const NECK_MAX = 35;

/** The face's centering ANCHOR, 0..1 — the eye midpoint when we have it (stable, the
 *  neck-dive fix), else the box geometric center (which sags low onto the jaw). Every
 *  consumer (saliency, lock continuity, the controller) steers on this one point. */
export function center(f: Face): { x: number; y: number } {
  if (f.eyeMid) return f.eyeMid;
  return { x: f.box.x + f.box.w / 2, y: f.box.y + f.box.h / 2 };
}

/** Saliency = bigger (closer) AND more central is more salient. Pure ranking score. */
export function saliency(f: Face): number {
  const c = center(f);
  const area = f.box.w * f.box.h;
  const offCenter = Math.hypot(c.x - 0.5, c.y - 0.5); // 0 = centered
  return area * (1 - Math.min(1, offCenter)); // big + centered wins
}

/**
 * Pick which face to follow, with a LOCK for continuity (the anti-oscillation core):
 *  • if `target` (a name) is set → follow that recognized person; ignore others.
 *  • else → keep following the LAST-locked person (matched by box proximity), unless
 *    they're gone OR another is DECISIVELY more salient (beats the lock by `margin`).
 *  • else (no lock yet) → the most salient.
 * Returns the chosen face + its center (the new lock anchor), or null if none to follow.
 */
export function pickTarget(
  faces: Face[],
  opts: { target?: string; lockAt?: { x: number; y: number } | null; margin?: number } = {},
): { face: Face; at: { x: number; y: number } } | null {
  if (faces.length === 0) return null;
  const margin = opts.margin ?? 1.4; // a challenger must be 40% more salient to steal the lock

  // NAMED target: follow only that person (confident match), ignore the rest.
  if (opts.target) {
    const named = faces.filter((f) => f.name?.toLowerCase() === opts.target!.toLowerCase());
    if (named.length === 0) return null; // target not present → caller searches
    const best = named.sort((a, b) => saliency(b) - saliency(a))[0]!;
    return { face: best, at: center(best) };
  }

  const ranked = [...faces].sort((a, b) => saliency(b) - saliency(a));
  // LOCK: if we were following someone, keep them unless gone / decisively beaten.
  if (opts.lockAt) {
    const nearest = nearestTo(faces, opts.lockAt);
    if (nearest) {
      const challenger = ranked[0]!;
      const keep = challenger === nearest || saliency(challenger) < saliency(nearest) * margin;
      const chosen = keep ? nearest : challenger;
      return { face: chosen, at: center(chosen) };
    }
  }
  // no lock (or lock lost): the most salient becomes the new lock.
  return { face: ranked[0]!, at: center(ranked[0]!) };
}

/** The face whose center is closest to a point (continuity match for the lock). */
function nearestTo(faces: Face[], at: { x: number; y: number }): Face | null {
  let best: Face | null = null; let bestD = Infinity;
  for (const f of faces) {
    const c = center(f);
    const d = Math.hypot(c.x - at.x, c.y - at.y);
    if (d < bestD) { bestD = d; best = f; }
  }
  // a face that jumped more than half the frame is probably NOT the same person.
  return bestD <= 0.5 ? best : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --------------------------------------------------------------------------- //
// The TICK — one full decision, as a PURE function over state.
// --------------------------------------------------------------------------- //
// This is the task loop's brain extracted so it's testable WITHOUT a process / WS /
// body: feed a scripted scene (faces per tick) + the prior state, get back the next
// state + the command to send (or null). The task's run() just wires sense→step→act.

export interface FollowState {
  pose: Pose;                              // where we believe the body is
  /** WHO we're committed to following (persists across brief disappearances), or null
   *  when not locked onto anyone yet. `name` is set if the locked person was recognized;
   *  `at` is their last-seen frame position (the re-find anchor). */
  lock: { name: string | null; at: { x: number; y: number } } | null;
  missing: number;                          // consecutive ticks the LOCKED person is unseen
  sweepDir: 1 | -1;                         // current search direction
  /** ticks remaining to DWELL (hold still + look) before the next sweep step — so the
   *  head pauses at each scan position long enough to actually recognize a face there,
   *  instead of panning past someone between recognize calls. */
  sweepDwell: number;
  /** ADAPTIVE per-axis control state (trial-and-adjust). We never assume a degrees↔pixels
   *  mapping (it drifts with phone weight / friction / wear) — each axis discovers its own
   *  step size live from whether the last move helped/overshot/stalled. See adaptive.ts. */
  pan: AxisState;
  tilt: AxisState;
  /** epoch ms until which we've YIELDED the body (a foreign mover took it — a brain-turn
   *  gesture, the console, another task). 0 = not yielded. While yielded we issue NO
   *  commands (don't fight the other mover), then resume following when it elapses. The
   *  behaviour defers to foreground actions; this is the cooldown. See [[facefollow-is-a-behaviour]]. */
  cooldownUntil: number;
  mode: 'track' | 'search' | 'yielded';
}

export interface FollowCfg {
  target?: string;     // named person to follow; else commit to the first salient person
  /** ticks with NO face present (and NO lock) before the head starts SEARCH-sweeping. A short
   *  grace so a one-tick gap on an empty scene doesn't immediately lurch into a sweep. */
  lostAfter: number;
  /** ticks to HOLD a LOST lock (face was locked, now unseen) before giving up + searching.
   *  Long enough to ride out bursty detection (multi-second gaps on a still face), not
   *  forever — so a person who truly left is eventually abandoned. Omit → CENTERED_HOLD_TICKS
   *  (~30s). This is the "lock and wait, but search when they're really gone" balance. */
  lostAfterCentered?: number;
  /** adaptive per-axis control (trial-and-adjust). Omit → DEFAULT_AXIS. */
  panAxis?: AxisCfg;
  tiltAxis?: AxisCfg;
  /** target smoothing 0..1 (EMA): fraction of the RAW detection blended into the anchor
   *  each tick. Low (~0.4) = heavily smoothed (ignores box jitter, follows the trend) →
   *  no twitch; 1 = act on the raw read (twitchy). */
  smooth?: number;
  /** degrees per sweep STEP (smaller = finer scan, less likely to pan past a face). */
  sweepDeg?: number;
  /** ticks to DWELL (hold still, look) at each sweep position before stepping again.
   *  This is the LATENCY fix: recognize is slow + samples stale frames, so if the head
   *  keeps moving it pans PAST a face before perception reports it. Dwelling lets the
   *  head settle so the recognize answer matches where it's actually pointing. */
  sweepDwell?: number;
  /** ms to YIELD the body after a FOREIGN mover takes it (a brain turn, the console, another
   *  task). During this cooldown faceFollow issues no commands so it doesn't fight the other
   *  mover; then it resumes following. faceFollow is a deferring behaviour, not an exclusive
   *  owner. Default 60_000 (1 min — "we'll adjust"). Cold start has NO cooldown: it only ever
   *  triggers on an actual foreign move. See [[facefollow-is-a-behaviour]]. */
  cooldownMs?: number;
}

/** Default body-yield cooldown after a foreign mover (ms). */
const COOLDOWN_MS = Number(process.env.FF_COOLDOWN_MS ?? 60_000);

/** How many ticks to HOLD position on a LOST lock before giving up and re-searching. The
 *  balance the user wants: long enough to ride out a real detection dropout (the on-device
 *  detector can blink for several seconds), but NOT forever — if the person is genuinely
 *  gone, resume searching so the dock looks for someone else instead of staring at an empty
 *  spot. ~43 ticks ≈ 30s at 700ms/tick. Override per-instance via `lostAfterCentered`. */
const CENTERED_HOLD_TICKS = Number(process.env.FF_CENTERED_HOLD ?? 43);

/** A tick's outcome: the new state, an optional absolute-pose command to send, and a
 *  human status (what the task would report). `command` null = nothing to do this tick. */
export interface FollowStep {
  state: FollowState;
  command: Pose | null;
  status: string;
}

export const initialFollowState = (pose: Pose = { foot: 0, neck: 0 }): FollowState =>
  ({ pose, lock: null, missing: 0, sweepDir: 1, sweepDwell: 0, pan: initAxis(), tilt: initAxis(), cooldownUntil: 0, mode: 'search' });

/** Adaptive move: given the current pose + the face's frame position, run each axis's
 *  trial-and-adjust controller. Returns the next pose (or null to HOLD) + updated axis
 *  states. NO mapping assumed — the step sizes float with the real machine (adaptive.ts).
 *  SIGN: face right of center (x>0.5) → pan foot POSITIVE (foot+90=right). Face high
 *  (y<0.5) → tilt neck NEGATIVE (neck−=up). */
export function adaptiveMove(
  pose: Pose, pan: AxisState, tilt: AxisState, at: { x: number; y: number },
  panCfg: AxisCfg, tiltCfg: AxisCfg,
): { pose: Pose | null; pan: AxisState; tilt: AxisState } {
  const ex = at.x - 0.5; // +ve = right of center
  const ey = at.y - 0.5; // +ve = below center
  const p = adaptAxis(pan, ex, panCfg);
  // tilt: face HIGH (ey<0) needs neck to go UP (negative); face LOW (ey>0) → neck down
  // (positive). adaptAxis(ey) gives +delta for ey>0, which is the correct neck sign.
  const t = adaptAxis(tilt, ey, tiltCfg);
  if (p.delta === 0 && t.delta === 0) return { pose: null, pan: p.state, tilt: t.state };
  const foot = clamp(pose.foot + p.delta, -FOOT_LIMIT, FOOT_LIMIT);
  const neck = clamp(pose.neck + t.delta, NECK_MIN, NECK_MAX);
  const moved = foot !== pose.foot || neck !== pose.neck;
  return { pose: moved ? { foot, neck } : null, pan: p.state, tilt: t.state };
}

/** Default dwell (ticks held at each sweep position) — enough for a recognize call to
 *  land before moving on. Env-tunable. */
const SWEEP_DWELL = Number(process.env.FF_SWEEP_DWELL ?? 2);
const SWEEP_DEG = Number(process.env.FF_SWEEP_DEG ?? 8);  // small sweep steps — finer scan, won't pan past a face
const SMOOTH = Number(process.env.FF_SMOOTH ?? 0.6);      // target EMA — moderate (real recognition noise only; jitter was hardware)
// The neck angle to RETURN TO while searching. Critical fix: after chasing a low/close
// face the neck can be left SATURATED at its down-limit (NECK_MAX) — then the sweep scans
// the FLOOR and can never find a standing/seated person. So while sweeping, ease the neck
// back toward a "look where faces actually are" home (slightly up = a person at desk/standing
// height in this dock's high mount). Tunable; default 0 (level) which un-sticks a saturated tilt.
const SWEEP_NECK = Number(process.env.FF_SWEEP_NECK ?? 0);

/** A search tick: DWELL (hold still + look) until the dwell counter elapses, THEN step.
 *  This makes the head pause at each scan position so perception (slow + stale) can
 *  actually see a face there before the head moves past it (the latency fix). */
function doSweep(state: FollowState, cfg: FollowCfg): { state: FollowState; command: Pose | null; pan: number } {
  const dwell = cfg.sweepDwell ?? SWEEP_DWELL;
  if (state.sweepDwell > 0) {
    // still dwelling — hold still, just look (no command), count down.
    return { state: { ...state, sweepDwell: state.sweepDwell - 1 }, command: null, pan: state.pose.foot };
  }
  // dwell elapsed → take one (small) sweep step, then dwell again at the new position.
  const s = sweepStep(state.pose, state.sweepDir, cfg.sweepDeg ?? SWEEP_DEG);
  return {
    state: { ...state, sweepDir: s.dir, pose: s.pose, sweepDwell: dwell },
    command: s.pose,
    pan: s.pose.foot,
  };
}

/** Find the LOCKED person among the faces seen this tick: by name if we know it,
 *  else the nearest face to where they were (continuity). Null if not present. */
function findLocked(faces: Face[], lock: NonNullable<FollowState['lock']>): Face | null {
  if (lock.name) {
    const byName = faces.find((f) => f.name?.toLowerCase() === lock.name!.toLowerCase());
    if (byName) return byName;
    // known person not matched by name this tick — fall through to position (a missed
    // recognition shouldn't drop the lock if someone is right where they were).
  }
  let best: Face | null = null; let bestD = Infinity;
  for (const f of faces) {
    const c = center(f); const d = Math.hypot(c.x - lock.at.x, c.y - lock.at.y);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best && bestD <= 0.35 ? best : null; // must be plausibly the same person
}

/**
 * One decision tick. Pure: (state, the faces seen this tick, cfg) → next state + command.
 * Mirrors exactly what task.run() does, minus the I/O.
 *
 * TWO MODES (the agreed spec):
 *  • NAMED (`target` set) — follow ONLY that person. If lost, keep searching for THEM
 *    indefinitely; a different person in view never becomes the target.
 *  • SALIENT (no target) — commit to the first salient face; HOLD on them through a
 *    brief dropout (so a momentary miss / look-away doesn't flip targets), but once
 *    they're gone past `lostAfter`, DROP the lock and re-pick the next salient face.
 *
 * In both modes, while the followed face is centered `nextPose` returns null → the head
 * HOLDS STILL (it moves only when the person leaves the deadband — "stay on me until I
 * move"). The within-tick lock also stops oscillation when two people are visible at once.
 */
export function stepFollow(
  state: FollowState, faces: Face[], cfg: FollowCfg,
  ctx: { foreignMover?: boolean; now?: number } = {},
): FollowStep {
  const now = ctx.now ?? Date.now();

  // 0) YIELD/COOLDOWN gate (faceFollow is a deferring behaviour, not an exclusive owner).
  //    A FOREIGN mover (brain-turn gesture, console, another task) just took the body →
  //    (re)start the cooldown and back off. While cooling down, issue NO commands so we
  //    don't fight; keep the lock so we resume on the same person. Cold start never enters
  //    here (foreignMover only true after a real foreign move). See [[facefollow-is-a-behaviour]].
  const cooldownMs = cfg.cooldownMs ?? COOLDOWN_MS;
  if (ctx.foreignMover) {
    return {
      state: { ...state, mode: 'yielded', cooldownUntil: now + cooldownMs },
      command: null,
      status: `yielded (another mover took the body) — cooling down ${Math.round(cooldownMs / 1000)}s`,
    };
  }
  if (state.cooldownUntil > now) {
    return {
      state: { ...state, mode: 'yielded' },
      command: null,
      status: `yielded — resuming in ${Math.ceil((state.cooldownUntil - now) / 1000)}s`,
    };
  }
  if (state.cooldownUntil !== 0) {
    // cooldown just elapsed — clear it + fall through to normal following (resume).
    state = { ...state, cooldownUntil: 0 };
  }

  // 1) Already committed to someone → try to RE-FIND them (don't re-pick this tick).
  if (state.lock) {
    const me = findLocked(faces, state.lock);
    if (me) {
      // SMOOTH the target: blend the raw (jittery) detection with the previous anchor
      // (an EMA). face-api's box center wobbles a few % per frame on a still face; acting
      // on each raw read makes the head TWITCH. Smoothing follows the trend, not the noise.
      const raw = center(me);
      const a = cfg.smooth ?? SMOOTH;            // 0=ignore new (frozen), 1=no smoothing (raw)
      const at = { x: state.lock.at.x + a * (raw.x - state.lock.at.x),
                   y: state.lock.at.y + a * (raw.y - state.lock.at.y) };
      // STEP-AND-SETTLE (no mapping assumed): small fixed step toward the face's side, settle.
      const mv = adaptiveMove(state.pose, state.pan, state.tilt, at, cfg.panAxis ?? DEFAULT_AXIS, cfg.tiltAxis ?? DEFAULT_AXIS);
      return {
        state: { ...state, mode: 'track', missing: 0, pose: mv.pose ?? state.pose,
                 pan: mv.pan, tilt: mv.tilt, lock: { name: me.name ?? state.lock.name, at } },
        command: mv.pose,                    // null when centered/settling → HOLD STILL
        status: `tracking ${state.lock.name ?? 'someone'} @${at.x.toFixed(2)},${at.y.toFixed(2)}`,
      };
    }
    // Locked person not visible this tick. THE RULE (user: "lock and wait — don't move on"):
    // once we have a lock, HOLD POSITION (no command) and keep looking right where they were,
    // re-tracking the instant detection returns. We do NOT immediately sweep away — detection
    // is bursty (multi-second gaps even on a still, frontal face), so a brief loss is almost
    // always a dropout, not a departure. Only after the WHOLE hold window (`lostAfterCentered`,
    // default ~30s) with no sight of them do we conclude they truly left and act on it.
    const missing = state.missing + 1;
    const named = !!cfg.target;
    const holdWindow = cfg.lostAfterCentered ?? CENTERED_HOLD_TICKS;
    if (missing < holdWindow) {
      return { state: { ...state, missing }, command: null,
               status: `holding on ${state.lock.name ?? 'them'} — detection gap (${missing}/${holdWindow} ticks)` };
    }
    // Hold window elapsed → they're gone.
    if (named) {
      // NAMED: keep searching for THEM (a newcomer never steals a named lock).
      const sw = doSweep({ ...state, mode: 'search', missing }, cfg);
      return { state: sw.state, command: sw.command,
               status: `searching for ${state.lock.name ?? cfg.target} (pan ${sw.pan.toFixed(0)}°${sw.command ? '' : ', looking'})` };
    }
    // SALIENT: drop the lock, fall through to step 2 to re-pick. CARRY `missing` so an empty
    // scene proceeds straight to searching.
    state = { ...state, lock: null, missing };
  }

  // 2) No lock (or salient just dropped it): pick someone to commit to. Fresh lock →
  // fresh adaptive steps (re-discover responsiveness for this new chase / new conditions).
  const pick = pickTarget(faces, { target: cfg.target });
  if (pick) {
    const pan0 = initAxis(cfg.panAxis ?? DEFAULT_AXIS);
    const tilt0 = initAxis(cfg.tiltAxis ?? DEFAULT_AXIS);
    const mv = adaptiveMove(state.pose, pan0, tilt0, pick.at, cfg.panAxis ?? DEFAULT_AXIS, cfg.tiltAxis ?? DEFAULT_AXIS);
    return {
      state: { ...state, mode: 'track', missing: 0, pose: mv.pose ?? state.pose,
               pan: mv.pan, tilt: mv.tilt, lock: { name: pick.face.name ?? null, at: pick.at } },
      command: mv.pose,
      status: `tracking ${pick.face.name ?? 'someone'} @${pick.at.x.toFixed(2)},${pick.at.y.toFixed(2)}`,
    };
  }

  // nobody to follow.
  const missing = state.missing + 1;
  if (missing >= cfg.lostAfter) {
    // dwell-then-step sweep (latency fix — pause at each position so perception lands).
    const sw = doSweep({ ...state, mode: 'search', missing }, cfg);
    return {
      state: sw.state,
      command: sw.command,
      status: `searching${cfg.target ? ` for ${cfg.target}` : ''} (pan ${sw.pan.toFixed(0)}°${sw.command ? '' : ', looking'})`,
    };
  }
  // brief hold before searching (don't lurch on a one-tick dropout)
  return {
    state: { ...state, missing },
    command: null,
    status: `${state.mode}: target missing (${missing}/${cfg.lostAfter})`,
  };
}

/**
 * One search-sweep step when no target is visible: pan outward from `from` in `dir`,
 * reversing at the limits. Returns the next pose + the (possibly flipped) direction.
 * "Search meaningfully from last-known": the caller seeds `from` with the last-locked
 * foot so the sweep starts where the person was, not from zero.
 */
export function sweepStep(
  cur: Pose, dir: 1 | -1, stepDeg = 15, neckHome = SWEEP_NECK,
): { pose: Pose; dir: 1 | -1 } {
  let next = cur.foot + dir * stepDeg;
  let d = dir;
  if (next > FOOT_LIMIT) { next = FOOT_LIMIT; d = -1; }
  if (next < -FOOT_LIMIT) { next = -FOOT_LIMIT; d = 1; }
  // RETURN the neck toward the search-home as we scan (half-step ease) — so a neck left
  // saturated from chasing a low/close face doesn't leave the sweep staring at the floor.
  // It un-sticks within a couple of sweep steps, then scans at face height.
  const home = clamp(neckHome, NECK_MIN, NECK_MAX);
  const neck = cur.neck + (home - cur.neck) * 0.5;
  return { pose: { foot: next, neck: clamp(neck, NECK_MIN, NECK_MAX) }, dir: d };
}
