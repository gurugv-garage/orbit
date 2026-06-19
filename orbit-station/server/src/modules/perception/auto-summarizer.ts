/**
 * Auto-summarizer (A1.5) — the always-on T2 of the perception pyramid
 * (docs/perception-pipeline.md §9). Until now a summary was produced ONLY on a
 * manual console "Summarize" click or a brain `force_get_current` tool call — so
 * grounding's `lastSummary` cache went stale between those. With the always-on
 * mic + stream, we fuse the recent window into a summary automatically, on a
 * debounced cadence, per active dock, so the brain's grounding is continuously
 * fresh without anyone asking.
 *
 * Cheap by construction (the pyramid principle): it only fires when NEW records
 * have accumulated since the last summary AND a min interval has elapsed — so an
 * idle dock costs nothing, and a busy one summarizes at most every `MIN_INTERVAL`.
 *
 * Pure-ish: the summarize+cache effect is injected (`summarizeAndCache`), the
 * clock is injectable, and `shouldSummarize` is a pure decision — all unit-tested.
 */

import type { SnapshotStore } from './snapshots.js';

/** How often, at most, a dock is auto-summarized (ms). */
export const AUTO_MIN_INTERVAL_MS = Number(process.env.PERCEPTION_AUTO_SUMMARY_MS ?? 60_000);
/** Don't summarize until at least this many new records have landed since last. */
export const AUTO_MIN_NEW_RECORDS = Number(process.env.PERCEPTION_AUTO_SUMMARY_MIN_RECS ?? 3);

export interface AutoState {
  /** wall-clock ms of the last auto-summary for this dock (0 = never). */
  lastAt: number;
  /** record count seen at the last auto-summary (to detect "new since"). */
  lastCount: number;
}

/**
 * Pure decision: should we auto-summarize this dock now? True iff enough new
 * records accumulated AND the min interval elapsed. Same inputs → same answer.
 */
export function shouldSummarize(
  state: AutoState,
  currentCount: number,
  now: number,
  minIntervalMs = AUTO_MIN_INTERVAL_MS,
  minNew = AUTO_MIN_NEW_RECORDS,
): boolean {
  const newRecords = currentCount - state.lastCount;
  if (newRecords < minNew) return false;
  if (now - state.lastAt < minIntervalMs) return false;
  return true;
}

export interface AutoSummarizerHandle {
  /** stop the timer. */
  stop(): void;
  /** force an evaluation tick now (used by tests). */
  tick(now?: number): Promise<void>;
}

/**
 * Start the auto-summarizer. Every `pollMs` it asks, per active dock, whether to
 * summarize (via `shouldSummarize`); if so it calls `summarizeAndCache(dockId)`
 * (the same flush→summarize→cache the console/force_get_current use) and records
 * the new baseline. `activeDocks` returns the docks with recent records.
 */
export function startAutoSummarizer(args: {
  store: SnapshotStore;
  activeDocks: () => string[];
  countFor: (dockId: string) => number;
  summarizeAndCache: (dockId: string) => Promise<void>;
  pollMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}): AutoSummarizerHandle {
  const { store: _store, activeDocks, countFor, summarizeAndCache } = args;
  const pollMs = args.pollMs ?? 15_000;
  const now = args.now ?? (() => Date.now());
  const states = new Map<string, AutoState>();
  const stateOf = (d: string): AutoState => states.get(d) ?? { lastAt: 0, lastCount: 0 };

  let running = false;
  const evaluate = async (atMs: number): Promise<void> => {
    if (running) return; // never overlap summarize calls
    running = true;
    try {
      for (const dock of activeDocks()) {
        const count = countFor(dock);
        if (!shouldSummarize(stateOf(dock), count, atMs)) continue;
        try {
          await summarizeAndCache(dock);
          states.set(dock, { lastAt: atMs, lastCount: count });
          args.log?.(`[perception] auto-summary ${dock} (${count} recs)`);
        } catch (err) {
          args.log?.(`[perception] auto-summary ${dock} failed: ${String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void evaluate(now()); }, pollMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref(): void }).unref();

  return {
    stop: () => clearInterval(timer),
    tick: (atMs?: number) => evaluate(atMs ?? now()),
  };
}
