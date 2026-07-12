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
  /** COHERENT mode (coherence-layer.md step 1): the raw tail is filtered to SALIENT
   *  events only — self-thoughts must act on the coherent layer (summary + beliefs +
   *  genuine happenings), never on raw mush. Conversations keep the full tail. */
  coherent?: boolean;
}

/** Is a record a genuine HAPPENING worth a self-thought's attention? Keeps: confident
 *  speech (good tier), non-low-salience sound events, vision windows (a committed record
 *  IS a scene change), and the compact STATE streams (identity/bodymotion). Drops:
 *  shaky/garbage speech (far-field mush), low-salience ambience — the raw noise that made
 *  idle remarks incoherent (coherence-layer.md §1).
 *
 *  Vision salience used to key off a structured `change` field, but that field was retired
 *  with the SIMPLE vision prompt (2026-07-09, commit 0d7b0cf) — it's gone from the payload.
 *  The DINOv2 change-gate now decides WHETHER vision runs at all, so every committed vision
 *  record already represents a real scene change; salience is just "has meaningful text".
 *  Keying off the dead `change` field made vision permanently non-salient — a person walking
 *  in never woke a reactive bit or reached the coherent grounding tail (fixed 2026-07-09). */
export function isSalient(r: SnapshotRecord): boolean {
  const p = r.payload as { confTier?: string; salience?: string; text?: string; audioSource?: string; transcriptConf?: number };
  switch (r.source.kind) {
    case 'speech': return (p.confTier ?? 'good') === 'good';
    // 'enriched' = the audio enricher's authoritative record (the durable audio kind now). Real
    // in-room speech is salient (unless the transcript was a low-confidence guess); a non-speech
    // event (media/sound) is salient only if notable/startling — mirrors vision-snapshot senseWake.
    // (Keying only off the old speech/sound kinds made ALL enriched audio non-salient — the same
    // regression the vision `change`-field note below warns about.)
    case 'enriched':
      return (p.audioSource ?? 'speech') === 'speech'
        ? (p.transcriptConf == null || p.transcriptConf >= 0.45)
        : p.salience === 'notable' || p.salience === 'startling';
    case 'sound': return p.salience === 'notable' || p.salience === 'startling';
    case 'vision': return !!p.text?.trim();   // change-gated → a committed record is a change
    case 'identity':
    case 'bodymotion': return true;   // STATE streams: compact, real transitions
    default: return false;            // unknown kinds (incl. future 'summary') stay out
  }
}

/**
 * Build the grounding block, or null when there's genuinely nothing to say (no
 * summary AND no recent records — a cold dock). Pure: same inputs → same string.
 */
export function buildGrounding(input: GroundingInput): string | null {
  const { last, recent, now, nowIso } = input;

  const { coherent } = input;
  const sift = (rs: SnapshotRecord[]) => (coherent ? rs.filter(isSalient) : rs);

  if (last) {
    const age = staleness(now - last.computedAt);
    const head = `Perception — last summary (${age}, covering ${clock(last.window.from)}–${clock(last.window.to)} IST): ${last.text.trim()}`;
    // raw records that START after the summary's window closed = "what's happened since".
    const since = sift(recent.filter((r) => r.interval.from > last.window.to));
    if (since.length === 0) return head;
    const tail = tailLines(stitch(since), MAX_RAW_LINES);
    const sinceFrom = clock(since[0]!.interval.from);
    const label = coherent ? 'salient events since' : 'Since then';
    return `${head}\n\n${label} (${sinceFrom}–${clock(nowIso)} IST${coherent ? '' : ', raw — not yet summarized'}):\n${tail}`;
  }

  // No summary yet: ground on the recent raw window alone.
  const cutoff = isoIst(new Date(now - RAW_FALLBACK_MS));
  const window = sift(recent.filter((r) => r.interval.from >= cutoff));
  if (window.length === 0) return null; // cold dock — nothing perceived (or nothing salient)
  const tail = tailLines(stitch(window), MAX_RAW_LINES);
  const from = clock(window[0]!.interval.from);
  return `Perception — recent (${from}–${clock(nowIso)} IST${coherent ? ', salient events' : ', raw — no summary yet'}):\n${tail}`;
}

// --------------------------------------------------------------------------- //
// Long-term memory in grounding — the PASSIVE awareness slice.
// --------------------------------------------------------------------------- //
// Grounding above is "what's happening NOW" (short-term). recall_memory is the
// agent's PULL of long-term beliefs. The gap this fills: every turn the agent should
// also PASSIVELY know the durable facts about WHO IS PRESENT, without having to ask.
// But derived beliefs are noisier/lower-confidence (see long-term-memory-curator.md
// §8b), so we add only a SMALL, confidence-ranked, present-relevant slice — tagged as
// beliefs-with-confidence so the agent hedges, never treats them as hard fact.

/** A memory belief, trimmed to what grounding shows. */
export interface GroundingBelief { subject: string; claim: string; confidence: number }

/** Min confidence for a belief to be worth pushing into every turn (low-confidence
 *  derived noise stays pull-only via recall_memory). */
export const GROUNDING_BELIEF_MIN_CONF = Number(process.env.PERCEPTION_GROUNDING_BELIEF_MIN_CONF ?? 0.4);
/** Cap the slice so the per-turn prompt stays small. */
export const GROUNDING_BELIEF_MAX = Number(process.env.PERCEPTION_GROUNDING_BELIEF_MAX ?? 6);

/**
 * Build the "what you already know about who's here" block from a candidate belief
 * set (the caller recalls beliefs for the present subjects). PURE: filters by
 * confidence, sorts high→low, caps, formats with explicit confidence so the agent
 * hedges. Returns '' when nothing clears the bar (then grounding omits the section).
 */
export function memoryGroundingSlice(
  beliefs: GroundingBelief[], minConf = GROUNDING_BELIEF_MIN_CONF, max = GROUNDING_BELIEF_MAX,
): string {
  const kept = beliefs
    .filter((b) => b.claim.trim() && b.confidence >= minConf)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, max);
  if (kept.length === 0) return '';
  const lines = kept.map((b) => {
    const who = b.subject ? `${b.subject}: ` : '';
    return `• ${who}${b.claim.trim()} (belief, conf ${b.confidence.toFixed(2)})`;
  });
  return 'What you already know (durable beliefs — may be imperfect; weigh by confidence):\n'
    + lines.join('\n');
}
