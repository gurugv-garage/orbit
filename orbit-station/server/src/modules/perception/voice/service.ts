/**
 * Voice-ID service — the standing voice-fingerprint stage (observe-only trial).
 *
 * speech-watch hands every final utterance's embedding here; we (a) keep a small
 * per-dock ring of recent embeddings so the Studio can enroll by NAMING recent
 * utterances (no separate enrollment audio path — same channel as matching, which
 * the trial showed is the #1 accuracy lever), and (b) match against the enrolled
 * gallery to produce the `voice: {name, score}` label on the speech snapshot.
 *
 * Enabled by default (embeddings cost ~11ms in the sidecar and the ring is needed
 * BEFORE the first enrollment); kill with PERCEPTION_VOICE_ID=0.
 */

import { VoiceGallery, classifyScore } from './gallery.js';

export interface RecentUtterance {
  /** utterance start (ms epoch) — doubles as the enroll-selection id. */
  id: number;
  text: string;
  durS: number;
  embedding: number[];
}

export interface VoiceLabel {
  /** the BEST enrolled candidate's display name ('unknown' only when the gallery is
   *  empty). Whether to trust it is `match` — the name is always surfaced so the
   *  console can show "guru? 0.32" and the trial can calibrate thresholds. */
  name: string;
  /** cosine to the nearest enrolled sample; absent when the gallery is empty. */
  score?: number;
  /** true only when score ≥ VOICE_MATCH — the label downstream logic may act on. */
  match?: boolean;
}

const RING_CAP = 20;

export class VoiceIdService {
  readonly gallery: VoiceGallery;
  #recent = new Map<string, RecentUtterance[]>();

  constructor(galleryPath: string) {
    this.gallery = new VoiceGallery(galleryPath);
  }

  enabled(): boolean { return process.env.PERCEPTION_VOICE_ID !== '0'; }

  /**
   * One final utterance's embedding → remember it (enrollment ring) + label it.
   * The best candidate's name is ALWAYS returned (with `match` saying whether it
   * cleared the bar) so the console can show near-misses and calibrate thresholds.
   */
  handleUtterance(dockId: string, embedding: number[], text: string, startedAtMs: number, durS: number): VoiceLabel {
    const ring = this.#recent.get(dockId) ?? [];
    ring.push({ id: startedAtMs, text, durS, embedding });
    if (ring.length > RING_CAP) ring.shift();
    this.#recent.set(dockId, ring);

    const best = this.gallery.match(embedding);
    if (!best) return { name: 'unknown' };
    return { name: best.name, score: Number(best.score.toFixed(3)), match: classifyScore(best.score) === 'match' };
  }

  /** Recent utterances for the enroll UI (embedding omitted — big and irrelevant to the console). */
  recent(dockId: string): Omit<RecentUtterance, 'embedding'>[] {
    return (this.#recent.get(dockId) ?? []).map(({ id, text, durS }) => ({ id, text, durS })).reverse();
  }

  /** Enroll selected recent utterances (by id) under `name`. Each becomes one
   *  gallery sample (its transcript kept as provenance). Returns how many landed. */
  enrollFromRecent(dockId: string, name: string, ids: number[]): number {
    const ring = this.#recent.get(dockId) ?? [];
    let n = 0;
    for (const id of ids) {
      const u = ring.find((r) => r.id === id);
      if (u) { this.gallery.enroll(name, u.embedding, u.text); n++; }
    }
    return n;
  }
}
