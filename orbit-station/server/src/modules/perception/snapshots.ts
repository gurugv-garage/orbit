/**
 * Snapshot records — the single, shared output format for the WebRTC perception
 * pipeline. Both the vision (qwen temporal) and speech (whisper) processors emit
 * records in THIS envelope so they share one timeline and one viewer.
 *
 * One path only: browser publishes mic+cam over WebRTC → station SFU → these
 * processors tap the stream → snapshot records. No standalone capture.
 *
 * Every record carries:
 *  - IST `from`/`to`/`durationMs` (the window a vision analysis covered, or the
 *    span of a speech utterance),
 *  - `source` provenance: a unique input id, modality, device, host,
 *  - `model`: what produced the text (name + endpoint),
 *  - `payload`: the text + modality extras.
 *
 * Built for MULTIPLE inputs later — `source.id` keys distinct cameras/mics. The
 * store is an in-memory ring; the console reads it via GET /api/perception/snapshots.
 */

import { persistRecord, loadRecent } from './retention.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** ISO-8601 in IST carrying the +05:30 offset. */
export function isoIst(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().replace('Z', '+05:30');
}

export interface SnapshotSource {
  id: string;                  // unique input: 'dock-app', 'cam-0', …
  // 'bodymotion' = the robot's OWN camera/body movement (egocentric context): the
  // camera is on a robot that can pan/drive, so "the view changed" may be ego-motion
  // (the robot moved) not world change (someone left). Other streams + the summarizer
  // read this to avoid mistaking one for the other.
  // 'sound' = an interpreted NON-SPEECH acoustic event from the audio enricher
  // (laughter, music, a crash — bg-audio-summarizer.md): an EVENT stream;
  // payload carries { text: summary, audioKind, salience, … }.
  // 'enriched' = the AUDIO ENRICHER's unified record (one kind for all its output; WHAT it contains
  // — speech / played media / a non-speech sound — is the `audioSource` field, not the kind).
  // 'speech'/'sound' remain for the LIVE parakeet records + historical data.
  // 'bodymotion' = the robot's OWN body/gaze — one record per servo command the station
  // issued: source, priority, accepted/rejected (+ who blocked), the pose it applied ON, the
  // target, and derived gaze (pan/tilt/facing). Keyed by DOCK, camera-independent (a servo-only
  // body has no video stream). (Consolidated 2026-07-20: this replaced BOTH the old thin
  // "camera-is-moving" ego stream AND the separate 'bodycmd' audit log — one well-named stream.
  // The live "is the camera moving now?" question moved to MotionExecutor.recentlyMoved.)
  kind: 'vision' | 'speech' | 'enriched' | 'identity' | 'emotion' | 'bodymotion' | 'sound' | 'summary';
  device: string;
  host: string;
}

/**
 * STATE vs EVENT streams — the distinction the windowing must respect:
 *  • EVENT (vision, speech, emotion): each record is a self-contained thing that
 *    happened. Overlap-with-window is the correct query.
 *  • STATE (identity, bodymotion): each record means "the value changed to X and
 *    HOLDS until the next change". To know the value DURING a window you may need
 *    the last record from BEFORE it (see SnapshotStore.inWindowWithState).
 * Generalizes to future look-back: a state's value is always "the last record as of
 * time T", regardless of when it last changed.
 */
// 'bodymotion' is now an EVENT stream (one record per servo command — a discrete thing that
// happened; keep them all on the timeline). It is NOT in STATE_KINDS: there's no explicit
// 'stationary'/settled record to carry forward, so "is the head moving / where is it pointing
// as of time T" comes from MotionExecutor.recentlyMoved / .pose at read time, not carry-forward.
export const STATE_KINDS: ReadonlyArray<SnapshotSource['kind']> = ['identity'];

export interface SnapshotRecord {
  ts: string;                  // = interval.from, IST
  tz: 'IST';
  dockId: string;
  source: SnapshotSource;
  model: { name: string; endpoint: string };
  interval: { from: string; to: string; durationMs: number };
  payload: { text: string } & Record<string, unknown>;
}

export function makeSnapshot(args: {
  dockId: string; source: SnapshotSource; model: { name: string; endpoint: string };
  from: Date; to: Date; payload: { text: string } & Record<string, unknown>;
}): SnapshotRecord {
  return {
    ts: isoIst(args.from),
    tz: 'IST',
    dockId: args.dockId,
    source: args.source,
    model: args.model,
    interval: {
      from: isoIst(args.from),
      to: isoIst(args.to),
      durationMs: args.to.getTime() - args.from.getTime(),
    },
    payload: args.payload,
  };
}

const CAP = Number(process.env.PERCEPTION_SNAPSHOT_CAP ?? 1000);
/** Keep a representative keyframe for this many recent vision windows (for the
 *  optional image-assisted summarization test). Base64 JPEGs are big, so a small
 *  ring. */
const KEYFRAME_CAP = Number(process.env.PERCEPTION_KEYFRAME_CAP ?? 120);

/** A keyframe tagged with the IST time it represents (a vision window's start). */
export interface Keyframe { ts: string; from: string; jpegB64: string }

/** In-memory ring of snapshot records (vision + speech + identity) + a small ring
 *  of representative vision keyframes. */
export class SnapshotStore {
  #recs: SnapshotRecord[] = [];
  #keyframes: Keyframe[] = [];
  #listeners = new Set<(r: SnapshotRecord) => void>();

  add(r: SnapshotRecord): void {
    this.#recs.push(r);
    if (this.#recs.length > CAP) this.#recs.splice(0, this.#recs.length - CAP);
    persistRecord(r);   // durable perception (§7c) — best-effort, never breaks the live add
    for (const l of this.#listeners) { try { l(r); } catch { /* */ } }
  }

  /** Restore recent perception from disk into the ring on boot (§7c) — so a restart doesn't
   *  amnesia-wipe the dock's recent history. De-dups against what's already present. */
  hydrate(dock: string, nowMs: number): number {
    const recent = loadRecent(dock, nowMs);
    if (!recent.length) return 0;
    const have = new Set(this.#recs.map((r) => `${r.interval.from}|${r.source.id}|${r.source.kind}`));
    let added = 0;
    for (const r of recent) {
      const k = `${r.interval.from}|${r.source.id}|${r.source.kind}`;
      if (!have.has(k)) { this.#recs.push(r); have.add(k); added++; }
    }
    if (this.#recs.length > CAP) this.#recs.splice(0, this.#recs.length - CAP);
    this.#recs.sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0));
    return added;
  }

  /** Patch a record's payload in place (e.g. the enricher upgrade enriching the live
   *  parakeet text with the Gemini acoustic read — audioKind/summary/salience/addressed). Re-notifies
   *  listeners AND re-persists, so the enrichment reaches DISK readers (the ego reading `recordsSince`
   *  off disk), not just the in-memory ring. The JSONL is append-only, so this appends a SECOND,
   *  enriched line for the same utterance; disk readers reconcile last-wins on `interval.from|source.id|
   *  source.kind` (see retention.dedupeLastWins) so they see only the patched version. No-op if the
   *  record already rolled off the ring. Returns whether it was found. */
  update(rec: SnapshotRecord, patch: Partial<SnapshotRecord['payload']>): boolean {
    const r = this.#recs.find((x) => x === rec);
    if (!r) return false;
    r.payload = { ...r.payload, ...patch };
    persistRecord(r);   // re-append the enriched record — close the enricher persist gap (durable)
    for (const l of this.#listeners) { try { l(r); } catch { /* */ } }
    return true;
  }

  /** Vision processor stashes one representative frame per window (for the test). */
  addKeyframe(k: Keyframe): void {
    this.#keyframes.push(k);
    if (this.#keyframes.length > KEYFRAME_CAP) this.#keyframes.splice(0, this.#keyframes.length - KEYFRAME_CAP);
  }

  /** Most-recent `limit` records, ORDERED BY interval.from ascending. */
  list(limit = CAP): SnapshotRecord[] {
    return [...this.#recs]
      .sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0))
      .slice(-limit);
  }

  /** Records whose start is at/after `sinceIso` (IST), ascending. */
  since(sinceIso: string): SnapshotRecord[] {
    return this.list(CAP).filter((r) => r.interval.from >= sinceIso);
  }

  /** Records that OVERLAP the window [fromIso, toIso] (IST), ascending. A record
   *  counts if any part of its interval falls inside the window — so a vision
   *  window or speech utterance straddling the start edge isn't silently dropped,
   *  and the upper bound excludes anything that began after the window closed. */
  inWindow(fromIso: string, toIso: string): SnapshotRecord[] {
    return this.list(CAP).filter((r) => r.interval.to >= fromIso && r.interval.from <= toIso);
  }

  /**
   * The value of a STATE stream AS OF `iso` — the most recent record of `kind`
   * whose interval started at/before `iso`, or undefined if none. This is the core
   * primitive for state streams: their records mean "the value changed to X and
   * HOLDS until the next change", so the value at any time T is just the last record
   * at/before T — regardless of when it last changed. Reusable for any "what's the
   * state right now / at time T" look-back (a processor, the summarizer, …), not
   * only the windowing below.
   */
  stateAt(kind: SnapshotSource['kind'], iso: string): SnapshotRecord | undefined {
    let prior: SnapshotRecord | undefined;
    for (const r of this.#recs) {
      if (r.source.kind !== kind || r.interval.from > iso) continue;
      if (!prior || r.interval.from > prior.interval.from) prior = r;
    }
    return prior;
  }

  /**
   * Like inWindow, but for STATE streams (see STATE_KINDS) it guarantees the value
   * the window OPENED with is present: if a state stream has no record starting at
   * exactly `from`, we carry in its `stateAt(from)` record. Without this, a window
   * whose camera-motion / presence last changed *before* it starts (or changed only
   * partway through) would be blind to the entering state — e.g. summarize "last 60s"
   * after the robot panned away 5 min ago → loses that it's pointed away; or the
   * window's first 30 s having no presence record. Event streams (vision/speech/
   * emotion) are self-contained, so overlap already covers them.
   */
  inWindowWithState(fromIso: string, toIso: string): SnapshotRecord[] {
    const inWin = this.inWindow(fromIso, toIso);
    const carried: SnapshotRecord[] = [];
    for (const kind of STATE_KINDS) {
      // The window covers its own opening for this kind iff some in-window record
      // started at/before `from`. If so, stateAt(from) IS that record (already in
      // inWin) — nothing to carry. Otherwise carry the entering state.
      const coversOpen = inWin.some((r) => r.source.kind === kind && r.interval.from <= fromIso);
      if (coversOpen) continue;
      const prior = this.stateAt(kind, fromIso);
      if (prior) carried.push(prior);
    }
    if (!carried.length) return inWin;
    return [...carried, ...inWin].sort((a, b) =>
      a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0);
  }

  /** Keyframes overlapping [fromIso, toIso], at most `max`, evenly sampled. */
  keyframesInWindow(fromIso: string, toIso: string, max: number): string[] {
    return sampleEvenly(
      this.#keyframes.filter((k) => k.from >= fromIso && k.from <= toIso).map((k) => k.jpegB64),
      max,
    );
  }

  /** ALL keyframes in [sinceIso, now], unsampled — for saving a take (replay can
   *  re-sample at summarize time). */
  keyframesAllSince(sinceIso: string): string[] {
    return this.#keyframes.filter((k) => k.from >= sinceIso).map((k) => k.jpegB64);
  }

  clear(): void { this.#recs = []; this.#keyframes = []; }

  subscribe(fn: (r: SnapshotRecord) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

/** Down-sample a list to at most `max`, evenly spaced (keeps first…last span). */
export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max || max <= 0) return items.slice(0, Math.max(0, max) || items.length);
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}
