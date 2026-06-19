/**
 * The proactive ATTENTION GATE (docs/perception-to-agent.md Decision 1) — the
 * cheap-rules tier of "should the robot raise something on its own right now?".
 *
 * A *candidate to speak* is a perception event worth the robot's attention: someone
 * arrived, a strong emotion, (later) the conversation turned relevant. The gate runs
 * the cheap rules over a SIGNALS snapshot and decides RAISE (→ a self-thought via
 * enqueueAutonomousTurn, which Phase 1 already routes through the session-state gate)
 * or stay QUIET. The LLM-judge tier (the pyramid) and the conversation-relevance tier
 * land later — the latter needs the always-on-mic shift (A1), so it's STUBBED here.
 *
 * This file is the PURE judge: (signals) → decision. No store, no bus, no clock except
 * via `signals.now`. Exhaustively unit-testable; the watcher (gate-watcher.ts) feeds it.
 *
 * Two cross-cutting rules every raise respects (so the robot doesn't nag):
 *  • COOLDOWN — at most one raise per `cooldownMs` window;
 *  • DEDUP — don't re-raise the same thing (`key`) back-to-back.
 */

export interface GateSignals {
  now: number;
  /** who is in frame right now (latest identity reading). */
  presentNames: string[];
  /** names that APPEARED since the last evaluation (a real arrival, camera stationary). */
  arrivedNames: string[];
  /** names that LEFT since the last evaluation. */
  departedNames: string[];
  /** a confident, clear emotion read this cycle (already gated upstream), if any. */
  strongEmotion?: { name: string; text: string };
  /** is the camera moving right now? arrivals/departures during ego-motion are NOT
   *  real world events (the robot looked around) — the gate must not raise on them. */
  cameraMoving: boolean;
  /** ms since the last perception snapshot of any kind — a silence/idle proxy. */
  msSinceLastSnapshot: number;
  /** when the gate last RAISED a thought (cooldown input). 0 if never. */
  lastRaisedAt: number;
  /** the key of the last raise (dedup input). */
  lastRaisedKey?: string;
  /**
   * STUB until A1 (always-on mic): a conversation-relevance signal — "my name came
   * up / a question I could answer". No real source today (the Android recognizer
   * owns the mic), so it's always undefined; the structure + rule exist + are tested.
   */
  relevance?: { reason: string; text: string };
}

export interface GateConfig {
  /** at most one raise per this window (default 90s). */
  cooldownMs: number;
  /** the gate is OFF unless enabled (proactivity is opt-in). */
  enabled: boolean;
}

export const DEFAULT_GATE_CONFIG: GateConfig = { cooldownMs: 90_000, enabled: false };

export type GateOutcome =
  | { raise: false; reason: string }
  | { raise: true; kind: string; key: string; text: string; confidence: number };

/**
 * The cheap-rules judge. Priority order (highest-confidence intent first):
 *  1. RELEVANCE (stubbed) — directly relevant conversation → almost always raise.
 *  2. ARRIVAL — a known/unknown person entered (camera stationary) → greet/note.
 *  3. STRONG EMOTION — a confident read on someone present → maybe check in.
 * Cooldown + dedup apply to every raise. Returns the thought text the robot will
 * consider (it may still choose to stay silent — a thought is permission, not duty).
 */
export function evaluateGate(s: GateSignals, cfg: GateConfig): GateOutcome {
  if (!cfg.enabled) return { raise: false, reason: 'gate disabled' };

  // COOLDOWN — don't nag. One raise per window.
  if (s.lastRaisedAt > 0 && s.now - s.lastRaisedAt < cfg.cooldownMs) {
    return { raise: false, reason: 'cooldown' };
  }

  const candidate = pickCandidate(s);
  if (!candidate) return { raise: false, reason: 'nothing worth raising' };

  // DEDUP — don't raise the same thing twice in a row.
  if (candidate.key === s.lastRaisedKey) return { raise: false, reason: 'duplicate of last raise' };

  return { raise: true, ...candidate };
}

function pickCandidate(s: GateSignals): { kind: string; key: string; text: string; confidence: number } | undefined {
  // 1. RELEVANCE (stub) — highest priority when it exists. No source until A1.
  if (s.relevance) {
    return {
      kind: 'self:relevance', key: `relevance:${s.relevance.reason}`,
      text: `[you noticed something worth responding to: ${s.relevance.text}]`,
      confidence: 0.9,
    };
  }

  // 2. ARRIVAL — only a REAL arrival (camera stationary; ego-motion arrivals are the
  //    robot looking around, not someone entering — Decision 5b egocentric awareness).
  if (!s.cameraMoving && s.arrivedNames.length > 0) {
    const who = s.arrivedNames.join(' and ');
    const known = !s.arrivedNames.includes('someone') && !s.arrivedNames.includes('unknown');
    return {
      kind: 'self:presence', key: `arrival:${s.arrivedNames.slice().sort().join(',')}`,
      text: known
        ? `[${who} just came into view — you might greet them]`
        : `[someone you don't recognize just appeared — you might say hello]`,
      confidence: 0.7,
    };
  }

  // 3. STRONG EMOTION — a confident read on someone present. Lower priority; the
  //    summarizer/emotion stream already hedged, so this is a soft "maybe check in".
  if (s.strongEmotion) {
    return {
      kind: 'self:emotion', key: `emotion:${s.strongEmotion.name}:${s.strongEmotion.text}`,
      text: `[you noticed ${s.strongEmotion.text} — you might check in if it seems right]`,
      confidence: 0.5,
    };
  }

  return undefined;
}
