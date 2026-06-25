/**
 * Sources for the long-term memory curator's CONSOLIDATE op — the selectable input
 * the curator promotes from (docs/decision-traces/long-term-memory-curator.md §3).
 *
 * A source is a CHOICE, not a restriction: for a given signal we read the best
 * available representation. Today the only source is diarized speech (a speech
 * snapshot carries BOTH the diarized `text` and the raw `sttText` — §3), so the seam
 * is small. It's a real seam so a future cleanup/event stream plugs in as another
 * source with zero churn to the consolidate logic.
 *
 * Pure + transport-free: it reads a SnapshotStore window and returns event-time-tagged
 * observations. No LLM, no store — unit-testable with a fake window.
 */
import type { SnapshotRecord, SnapshotStore } from '../../snapshots.js';

/** One observation handed to consolidate — already event-time-stamped + (optionally)
 *  enriched with who was present when it happened (§5 alignment). */
export interface Observation {
  /** lineage back-link to the source snapshot. Snapshots aren't individually id'd, so
   *  this is `<kind>@<ts>` (the stream kind + the event-time iso) — unique per utterance
   *  and enough to trace a belief back to what it came from. */
  lineageId: string;
  /** event-time the thing happened (IST iso from the snapshot's `from`). */
  atIso: string;
  /** the refined text the curator reasons over (diarized when available). */
  text: string;
  /** the raw text, kept for corroboration when the refined read is thin (§3). */
  raw?: string;
  /** speaker label if diarization assigned one. */
  speaker?: number;
  /** who was present at `atIso` — the event-time-aligned identity attachment (§5). */
  presentAt?: string;
}

/** Which source the curator draws from. Open string (extensible); 'diarized-speech'
 *  is the only one wired today. */
export type SourceKind = 'diarized-speech';

/** How a window of the snapshot ring becomes consolidate's observations. The store +
 *  an `as-of identity` resolver are injected so this is testable without globals. */
export interface SourceContext {
  store: SnapshotStore;
  /** who was present as-of an event-time iso (wraps store.stateAt('identity', iso)). */
  presentAt: (iso: string) => string | undefined;
}

/**
 * Pull the consolidate observations for a dock from a window [fromIso, toIso].
 * Default source = diarized speech: each speech snapshot in the window becomes one
 * Observation, preferring the diarized `text`, carrying the raw `sttText` for
 * corroboration, and attaching who-was-present at the utterance's event-time.
 */
export function observationsIn(
  ctx: SourceContext, dockId: string, fromIso: string, toIso: string, kind: SourceKind = 'diarized-speech',
): Observation[] {
  if (kind !== 'diarized-speech') return [];
  return ctx.store
    .inWindow(fromIso, toIso)
    .filter((r) => r.dockId === dockId && r.source.kind === 'speech')
    .map((r) => toObservation(r, ctx))
    .filter((o): o is Observation => o != null);
}

/**
 * PENDING observations for consolidate — the unconsolidated speech AFTER `watermarkIso`
 * (exclusive), oldest-first, capped at `limit` (the bounded batch under a flood). This
 * is the load-aware read: only the new span, never the whole ring, exactly-once.
 * `watermarkIso` = '' means "everything" (first pass).
 */
export function pendingObservations(
  ctx: SourceContext, dockId: string, watermarkIso: string, limit: number, kind: SourceKind = 'diarized-speech',
): Observation[] {
  if (kind !== 'diarized-speech' || limit <= 0) return [];
  const all = ctx.store.list()
    .filter((r) => r.dockId === dockId && r.source.kind === 'speech' && r.interval.from > watermarkIso)
    .sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0));
  return all
    .slice(0, limit)
    .map((r) => toObservation(r, ctx))
    .filter((o): o is Observation => o != null);
}

/** Count + oldest-event-time of pending (post-watermark) speech for a dock — the inputs
 *  the cadence decides from. Cheap: one ring scan. oldestIso = '' if nothing pending. */
export function pendingStats(
  store: SnapshotStore, dockId: string, watermarkIso: string,
): { count: number; oldestIso: string; newestIso: string } {
  let count = 0; let oldestIso = ''; let newestIso = '';
  for (const r of store.list()) {
    if (r.dockId !== dockId || r.source.kind !== 'speech' || r.interval.from <= watermarkIso) continue;
    count++;
    if (!oldestIso || r.interval.from < oldestIso) oldestIso = r.interval.from;
    if (!newestIso || r.interval.from > newestIso) newestIso = r.interval.from;
  }
  return { count, oldestIso, newestIso };
}

/** A speech snapshot → an Observation (diarized text preferred; raw kept; identity
 *  attached as-of the utterance start). Returns null for an empty/word-less utterance. */
function toObservation(r: SnapshotRecord, ctx: SourceContext): Observation | null {
  const p = r.payload as { text?: string; sttText?: string; speaker?: number };
  // diarized `text` is the refined read; if a raw sttText exists it's the original
  // Parakeet (text was overwritten by diarization) — keep it for corroboration.
  const text = (p.text ?? '').trim();
  if (!text || text.replace(/[^a-z0-9]/gi, '').length < 2) return null; // no real words
  const atIso = r.interval.from;
  return {
    lineageId: `${r.source.kind}@${atIso}`,
    atIso,
    text,
    raw: p.sttText && p.sttText.trim() && p.sttText.trim() !== text ? p.sttText.trim() : undefined,
    speaker: p.speaker,
    presentAt: ctx.presentAt(atIso),
  };
}
