/**
 * Consolidate CADENCE — the load-aware decision of WHEN to consolidate and HOW MUCH,
 * for the realistic regime: speech comes as occasional trickles AND sudden floods, and
 * memory must keep up reliably + efficiently (docs/decision-traces/long-term-memory-curator.md §6a).
 *
 * Pure functions over counts/timestamps — no store, no LLM, no clock except `now` —
 * so every flood/trickle/watermark case is exhaustively unit-testable.
 *
 * The model: a per-dock WATERMARK (last-consolidated event-time). "Pending" = speech
 * after the watermark. Each pass processes only a BOUNDED, oldest chunk of pending and
 * advances the watermark over exactly what it sent — so every utterance is consolidated
 * EXACTLY ONCE: floods never re-send old context, trickles never get stranded.
 *
 * KNOBS ARE FIRST GUESSES. The mechanism is solid; these numbers are tuned-by-eye until
 * we watch a real flood (flagged in the doc's v1-delta). All env-overridable.
 */

/** ≥ this many pending utterances → consolidate now (the flood/accumulation trigger). */
export const CONSOLIDATE_BATCH_AT = Number(process.env.PERCEPTION_CONSOLIDATE_AT ?? 5);
/** oldest pending utterance older than this (ms) → flush even below the batch size, so a
 *  lone sentence in a quiet room isn't stranded until the ring drops it (trickle/age). */
export const CONSOLIDATE_MAX_AGE_MS = Number(process.env.PERCEPTION_CONSOLIDATE_MAX_AGE_MS ?? 5 * 60_000);
/** no new speech for this long AND something is pending → flush (the exchange ended). */
export const CONSOLIDATE_QUIET_MS = Number(process.env.PERCEPTION_CONSOLIDATE_QUIET_MS ?? 45_000);
/** never send more than this many utterances in one pass — bounds the prompt + cost
 *  under a flood; the rest drains over the next ticks (backpressure, not pile-up). */
export const CONSOLIDATE_MAX_BATCH = Number(process.env.PERCEPTION_CONSOLIDATE_MAX_BATCH ?? 20);
/** floor between passes (ms) — a flood can't thrash the shared GPU. */
export const CONSOLIDATE_FLOOR_MS = Number(process.env.PERCEPTION_CONSOLIDATE_FLOOR_MS ?? 30_000);

/** What the cadence decides from. All event-times are ms epoch. */
export interface ConsolidateSignals {
  /** count of unconsolidated (pending) utterances. */
  pendingCount: number;
  /** age of the OLDEST pending utterance (ms); 0 if none pending. */
  oldestPendingAgeMs: number;
  /** time since the most recent speech of ANY kind (ms); large when the room is quiet. */
  sinceLastSpeechMs: number;
  /** time since this dock's last consolidate pass (ms). */
  sinceLastPassMs: number;
}

export interface CadenceCfg {
  batchAt: number;
  maxAgeMs: number;
  quietMs: number;
  floorMs: number;
}

export const DEFAULT_CADENCE: CadenceCfg = {
  batchAt: CONSOLIDATE_BATCH_AT,
  maxAgeMs: CONSOLIDATE_MAX_AGE_MS,
  quietMs: CONSOLIDATE_QUIET_MS,
  floorMs: CONSOLIDATE_FLOOR_MS,
};

export type ConsolidateReason = 'flood' | 'age' | 'quiet';

/**
 * Decide whether to consolidate now, and why. Returns null to wait. The floor gates
 * everything EXCEPT it never strands an age-critical backlog (an old pending span flushes
 * even within the floor, so the ring can't drop it). `force` (run-now) bypasses the floor.
 */
export function decideConsolidate(
  s: ConsolidateSignals, cfg: CadenceCfg = DEFAULT_CADENCE, force = false,
): ConsolidateReason | null {
  if (s.pendingCount <= 0) return null;
  const withinFloor = s.sinceLastPassMs < cfg.floorMs;

  // AGE is the safety net — it overrides the floor (don't let the ring drop unconsolidated
  // speech just because we consolidated something else recently).
  if (s.oldestPendingAgeMs >= cfg.maxAgeMs) return 'age';
  if (withinFloor && !force) return null;

  if (s.pendingCount >= cfg.batchAt) return 'flood';
  if (s.sinceLastSpeechMs >= cfg.quietMs) return 'quiet';
  if (force) return 'flood'; // run-now with a small backlog → just process it
  return null;
}

/**
 * How many of the pending utterances to take THIS pass (adaptive: all of a small
 * backlog for freshness; a capped oldest chunk under a flood, draining over ticks).
 * Always ≥1 when there's anything pending (so a flush actually flushes).
 */
export function batchSize(pendingCount: number, cfg: CadenceCfg = DEFAULT_CADENCE,
  maxBatch = CONSOLIDATE_MAX_BATCH): number {
  if (pendingCount <= 0) return 0;
  return Math.min(pendingCount, maxBatch);
}
