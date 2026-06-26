/**
 * STEP-AND-SETTLE control — the RELIABLY-IMPLEMENTABLE controller for this machine, where:
 *   • there's NO trustworthy degrees↔pixels mapping (friction, slop, wear),
 *   • the camera FOV is narrow,
 *   • detection is BURSTY (sees you a few frames, then blind for seconds) AND LAGGY (the
 *     reported position trails the head by a tick or two — a STALE read).
 *
 * The design bar (user): the algorithm must not just *sound* right, it must be implementable
 * from signals we can actually TRUST. We trust only two things per tick: (1) is a face
 * present, (2) which SIDE of center it's on (the sign). We do NOT trust the exact position
 * magnitude (it's laggy), and we CANNOT tell WHY a face vanished (moved-off-it vs a random
 * detection blink look identical). So the controller uses only sign + presence:
 *
 *   1. face present + outside the deadband → take ONE small, FIXED step toward its side;
 *   2. then SETTLE: issue no move for a couple of ticks so the servo stops and a FRESH
 *      (non-stale) detection can land before we decide again — this is what kills the
 *      overshoot (the old controller flung ~56° by acting on stale reads + growing the step);
 *   3. re-read; still off → another small step; centered → hold.
 *
 * No growing, no shrinking, no reasoning about why the face disappeared — nothing that
 * depends on a signal we can't trust. Small + patient converges; it cannot fling the camera
 * past the person. Mirrors the search sweep's proven dwell-then-step pattern.
 *
 * Per-axis state is carried between ticks. Pure: same inputs → same (move, state').
 */

export interface AxisCfg {
  deadband: number;   // |error| within this (per axis) → centered, hold (0..1 of frame)
  step: number;       // the FIXED step taken toward the face's side each move (deg) — small
  settleTicks: number; // ticks to HOLD STILL after a move (let the servo settle + a fresh,
                       // non-stale detection land) before moving again. The anti-overshoot.
}

// Small fixed step + a short settle. Small enough that one step can't fling the narrow FOV
// past the person; settle long enough that the next decision uses a FRESH look, not a stale one.
export const DEFAULT_AXIS: AxisCfg = {
  deadband: 0.10, step: 5, settleTicks: 1,
};

/** Per-axis state: how many settle ticks remain before we may move this axis again. */
export interface AxisState {
  cooldown: number; // ticks remaining to hold still (post-move settle)
}

export const initAxis = (_cfg: AxisCfg = DEFAULT_AXIS): AxisState => ({ cooldown: 0 });

/** One tick on an axis. `err` = signed error (face_pos − 0.5). Returns a signed delta to
 *  apply (deg; 0 = hold this tick) + the new state. Trusts only SIGN + the deadband; takes a
 *  fixed small step, then settles. */
export function adaptAxis(st: AxisState, err: number, cfg: AxisCfg = DEFAULT_AXIS): { delta: number; state: AxisState } {
  const mag = Math.abs(err);
  // Centered enough → hold, clear any settle (we're done correcting this axis).
  if (mag < cfg.deadband) return { delta: 0, state: { cooldown: 0 } };
  // Still settling from the last move → hold still so the next decision sees a fresh look.
  if (st.cooldown > 0) return { delta: 0, state: { cooldown: st.cooldown - 1 } };
  // Off-center and free to move → one small fixed step toward the face's side, then settle.
  const dir = err > 0 ? 1 : -1;
  return { delta: dir * cfg.step, state: { cooldown: cfg.settleTicks } };
}
