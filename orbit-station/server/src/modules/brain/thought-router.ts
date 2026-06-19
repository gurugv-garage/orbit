/**
 * ThoughtRouter — the PURE decision at the heart of internal-thought routing
 * (docs/perception-to-brain.md Decision 2.2).
 *
 * A station-originated turn (a background TASK notification, or the robot's own
 * perception THOUGHT) is a *candidate to speak*. Before it takes the lane it runs
 * this gate, which decides — given the current session state, the thought's
 * staleness, and a settle gap — whether to RUN it now, DEFER it (hold, re-check
 * later), or DROP it (too old / never relevant again).
 *
 * Why a pure function (not inline in #drainAuto): the rule is a small truth table
 * over an explicit state enum, and it MUST be exhaustively unit-testable without a
 * live LLM / dock / mic. Pulling it out of the imperative drain loop makes every
 * cell of the table a one-line test (see thought-router.test.ts). #drainAuto stays
 * the *mechanism* (await the lane, sleep, loop); this is the *policy*.
 *
 * Nothing here awaits, fetches, or touches time except via the `now` argument —
 * deterministic by construction.
 */

/**
 * The dock session's coarse state, as the gate sees it. Derived from the
 * session's existing flags by DockBrainSession.state():
 *  - `thinking`  — a turn (user OR self/task) is in flight (#running / #turnActive).
 *  - `speaking`  — TTS is playing the last answer (noteSpeech latched #speaking).
 *  - `listening` — the user is MID-UTTERANCE (words still arriving). NOTE: today
 *    this has no real signal (the Android recognizer owns the mic and only hands
 *    us a finalized sentence), so it is STUBBED — the routing is built + tested
 *    against an injected flag; the wire lands with the always-on-mic shift
 *    (perception-to-brain.md "THE PHASE-1 CAVEAT").
 *  - `idle`      — none of the above; free to run.
 */
export type SessionState = 'idle' | 'listening' | 'speaking' | 'thinking';

/**
 * What to do with a candidate turn:
 *  - `run`   — take the lane now.
 *  - `defer` — not now; leave it queued and re-evaluate when the lane next frees.
 *  - `drop`  — discard permanently (stale: it waited past its expiry, so the news
 *              is no longer worth speaking — a 30-s-old "someone walked in" isn't).
 */
export type ThoughtDecision = 'run' | 'defer' | 'drop';

export interface ThoughtRouterInput {
  /** the session state at decision time. */
  state: SessionState;
  /** decision-time wall clock (ms). Injected for determinism. */
  now: number;
  /** drop the turn if it can't start before this wall clock (ms); undefined = never stale. */
  expiresAt?: number;
  /** when the last turn ENDED (ms); 0 if none yet. Drives the settle gap. */
  lastTurnEndedAt: number;
  /** don't barge into a rapid exchange: require this gap (ms) after the last turn. */
  settleMs: number;
}

/**
 * The single routing decision. Order matters:
 *  1. STALENESS first — an expired thought is dropped regardless of state (no point
 *     deferring something we'd never speak).
 *  2. BUSY states (`thinking`/`speaking`/`listening`) → defer. A self-thought never
 *     supersedes a user turn; it waits behind a running turn, behind our own TTS,
 *     and (when the signal exists) behind a user who's mid-utterance.
 *  3. SETTLE gap → defer briefly so we don't barge into a just-ended rapid exchange.
 *  4. Otherwise (`idle`, settled, fresh) → run.
 *
 * Pure: same inputs → same output, always.
 */
export function decideThought(input: ThoughtRouterInput): ThoughtDecision {
  const { state, now, expiresAt, lastTurnEndedAt, settleMs } = input;

  // 1. stale news is dropped, not held — true in EVERY state.
  if (expiresAt != null && now > expiresAt) return 'drop';

  // 2. the lane is occupied (a turn running, TTS playing) or the user is talking —
  //    hold and re-evaluate when it frees. The user always wins.
  if (state === 'thinking' || state === 'speaking' || state === 'listening') return 'defer';

  // 3. idle, but a turn ended very recently — give a rapid exchange room to continue.
  if (settleMs > 0 && now - lastTurnEndedAt < settleMs) return 'defer';

  // 4. idle, settled, fresh — take the lane.
  return 'run';
}
