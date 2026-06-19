/**
 * Perception GROUNDING — the context every brain turn (user OR self) carries so
 * the agent reasons over what's been happening, not just the current instant
 * (docs/perception-to-brain.md Decision 3.1).
 *
 * The decided shape (NOT a fresh summarize per turn — that's 5–15 s of Gemini we
 * can't put on the turn's critical path):
 *   1. the LAST summary, verbatim, stamped with its window AND how stale it is, so
 *      the agent knows whether it's live or old and can hedge ("a few minutes ago…");
 *   2. the recent RAW stream SINCE that summary — the stitched, timestamped,
 *      speaker/confidence-tagged records that have accumulated after it (reusing the
 *      summarizer's own stitch()), so the agent has "what's happened since".
 * If no summary exists yet, grounding is just the recent raw window with its times.
 *
 * This module is the PURE builder (buildGrounding) + the cache type. The perception
 * module owns a LastSummary cache (set on each successful /snapshots/summarize) and
 * exposes a PerceptionGroundingApi facade the brain reads per turn. No network here.
 */

import type { SnapshotRecord } from './snapshots.js';
import { isoIst } from './snapshots.js';
import { stitch } from './summarizer.js';

/** A produced summary, cached for grounding. `window` is the IST range it covered;
 *  `computedAt` is wall-clock ms (for staleness). One per dock. */
export interface LastSummary {
  dockId: string;
  text: string;
  window: { from: string; to: string }; // IST ISO
  computedAt: number;                    // Date.now() when produced
}

/** How long of a raw tail to stitch when there's NO prior summary (the whole
 *  grounding is then this recent window). Kept modest so the prompt stays small. */
export const RAW_FALLBACK_MS = 90_000;
/** Cap the stitched raw tail so a chatty window can't blow up the prompt. */
export const MAX_RAW_LINES = 40;

/** Human staleness phrase from a millisecond age — drives the agent's hedging. */
export function staleness(ageMs: number): string {
  if (ageMs < 20_000) return 'just now';
  const sec = Math.round(ageMs / 1000);
  if (sec < 90) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

/** HH:MM:SS of an IST ISO timestamp (matches stitch()'s line format). */
function clock(iso: string): string {
  return iso.slice(11, 19);
}

/** Trim a stitched block to the last N lines (most recent), tagging if truncated. */
function tailLines(stitched: string, max: number): string {
  if (!stitched) return '';
  const lines = stitched.split('\n');
  if (lines.length <= max) return stitched;
  return `…\n${lines.slice(-max).join('\n')}`;
}

export interface GroundingInput {
  /** the most recent cached summary for this dock, or null if none produced yet. */
  last: LastSummary | null;
  /** ALL recent snapshot records (ascending). The builder slices what it needs:
   *  records AFTER the summary's window (the "since then" tail), or a recent
   *  fallback window when there's no summary. */
  recent: SnapshotRecord[];
  /** decision-time wall clock (ms) — injected for deterministic tests. */
  now: number;
  /** decision-time IST ISO (= isoIst(new Date(now))) — injected for tests. */
  nowIso: string;
}

/**
 * Build the grounding block, or null when there's genuinely nothing to say (no
 * summary AND no recent records — a cold dock). Pure: same inputs → same string.
 */
export function buildGrounding(input: GroundingInput): string | null {
  const { last, recent, now, nowIso } = input;

  if (last) {
    const age = staleness(now - last.computedAt);
    const head = `Perception — last summary (${age}, covering ${clock(last.window.from)}–${clock(last.window.to)} IST): ${last.text.trim()}`;
    // raw records that START after the summary's window closed = "what's happened since".
    const since = recent.filter((r) => r.interval.from > last.window.to);
    if (since.length === 0) return head;
    const tail = tailLines(stitch(since), MAX_RAW_LINES);
    const sinceFrom = clock(since[0]!.interval.from);
    return `${head}\n\nSince then (${sinceFrom}–${clock(nowIso)} IST, raw — not yet summarized):\n${tail}`;
  }

  // No summary yet: ground on the recent raw window alone.
  const cutoff = isoIst(new Date(now - RAW_FALLBACK_MS));
  const window = recent.filter((r) => r.interval.from >= cutoff);
  if (window.length === 0) return null; // cold dock — nothing perceived
  const tail = tailLines(stitch(window), MAX_RAW_LINES);
  const from = clock(window[0]!.interval.from);
  return `Perception — recent (${from}–${clock(nowIso)} IST, raw — no summary yet):\n${tail}`;
}
