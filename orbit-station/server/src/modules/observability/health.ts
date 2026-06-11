/**
 * UX-health metrics derived from the observability turns — the regression
 * tripwire for "snappy and reliable". Computed on demand from TurnRecords
 * (no extra ingest state), served at GET /api/observability/health.
 *
 * What it watches (each maps to a live-observed failure mode):
 *  - firstTokenMs / firstSpeechMs / settleMs percentiles → snappiness drifting
 *  - errorSteps → spoken "couldn't reach my model" failures (stopReason ERROR)
 *  - toolErrors → tool results carrying exceptions (e.g. the TurnLog CME)
 *  - midTurnSpeechDrops → the speaking signal fell BETWEEN sentences of one
 *    reply (the mic re-arm-over-own-voice bug; should be 0 after the
 *    SpeakingEdgeGate fix — any growth is a regression)
 *  - unfinishedTurns → turns that never got a TurnEnd (cancelled/crashed)
 *
 * Pure module → unit-tested without sqlite/bus (health.test.ts).
 */

import type { TurnRecord } from './types.js';

export interface TurnHealth {
  turnId: string;
  startedAt: number;
  /** TurnStart → first stream delta of step 1 (time-to-first-token). */
  firstTokenMs?: number;
  /** TurnStart → first TTS audio (the user hears something). */
  firstSpeechMs?: number;
  /** TurnStart → TurnSettled (TTS tail done — the full UX turn). */
  settleMs?: number;
  /** TurnStart → TurnEnd (the LLM loop only). */
  durationMs?: number;
  steps: number;
  /** steps that ended stopReason=ERROR (the spoken-failure path). */
  errorSteps: number;
  /** tool executions flagged isError. */
  toolErrors: number;
  /** speech windows that fell+rose again within one turn (mid-reply drop). */
  midTurnSpeechDrops: number;
  /** no TurnEnd ever arrived. */
  unfinished: boolean;
}

export function turnHealth(t: TurnRecord): TurnHealth {
  const firstStream = t.steps.map((s) => s.streamStartedAt).find((x) => x != null);
  const firstSpeech = t.speech?.[0]?.startedAt;
  let drops = 0;
  const speech = t.speech ?? [];
  for (let i = 1; i < speech.length; i++) {
    const prev = speech[i - 1]!;
    const cur = speech[i]!;
    // A positive gap between windows = the speaking signal genuinely fell and
    // rose again. Only count gaps INSIDE the turn (before TurnEnd) — the tail
    // after endedAt is the legitimate post-loop TTS run-out.
    if (prev.endedAt != null && cur.startedAt > prev.endedAt
      && (t.endedAt == null || cur.startedAt <= t.endedAt)) drops++;
  }
  return {
    turnId: t.turnId,
    startedAt: t.startedAt,
    firstTokenMs: firstStream != null ? firstStream - t.startedAt : undefined,
    firstSpeechMs: firstSpeech != null ? firstSpeech - t.startedAt : undefined,
    settleMs: t.settledAt != null ? t.settledAt - t.startedAt : undefined,
    durationMs: t.endedAt != null ? t.endedAt - t.startedAt : undefined,
    steps: t.steps.length,
    errorSteps: t.steps.filter((s) => s.stopReason === 'ERROR').length,
    toolErrors: t.steps.reduce((n, s) => n + s.tools.filter((tc) => tc.isError).length, 0),
    midTurnSpeechDrops: drops,
    unfinished: t.endedAt == null,
  };
}

export interface Percentiles { p50?: number; p90?: number; max?: number; n: number }

export function percentiles(values: number[]): Percentiles {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const at = (q: number) => a[Math.min(a.length - 1, Math.floor(a.length * q))]!;
  return { p50: at(0.5), p90: at(0.9), max: a[a.length - 1]!, n: a.length };
}

export interface HealthSummary {
  window: number;                       // turns considered
  firstTokenMs: Percentiles;
  firstSpeechMs: Percentiles;
  settleMs: Percentiles;
  durationMs: Percentiles;
  stepsPerTurn: Percentiles;
  /** counts over the window — regressions show up as these growing. */
  errorSteps: number;
  toolErrors: number;
  midTurnSpeechDrops: number;
  unfinishedTurns: number;
  /** input tokens of the LAST step seen (prompt growth watch); undefined until
   *  the dock ships usage. */
  lastInputTokens?: number;
  inputTokens: Percentiles;
}

export function healthSummary(turns: TurnRecord[]): HealthSummary {
  const hs = turns.map(turnHealth);
  const nums = (f: (h: TurnHealth) => number | undefined) =>
    hs.map(f).filter((x): x is number => x != null);
  const tokens = turns.flatMap((t) =>
    t.steps.map((s) => s.usage?.inputTokens).filter((x): x is number => x != null && x > 0));
  return {
    window: turns.length,
    firstTokenMs: percentiles(nums((h) => h.firstTokenMs)),
    firstSpeechMs: percentiles(nums((h) => h.firstSpeechMs)),
    settleMs: percentiles(nums((h) => h.settleMs)),
    durationMs: percentiles(nums((h) => h.durationMs)),
    stepsPerTurn: percentiles(hs.map((h) => h.steps)),
    errorSteps: hs.reduce((n, h) => n + h.errorSteps, 0),
    toolErrors: hs.reduce((n, h) => n + h.toolErrors, 0),
    midTurnSpeechDrops: hs.reduce((n, h) => n + h.midTurnSpeechDrops, 0),
    unfinishedTurns: hs.filter((h) => h.unfinished).length,
    lastInputTokens: tokens.length ? tokens[tokens.length - 1] : undefined,
    inputTokens: percentiles(tokens),
  };
}
