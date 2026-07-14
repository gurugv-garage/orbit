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

import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { utteranceWavPath } from '../processors/speech-watch.js';
import { VoiceGallery, RESERVED_DECOY, classifyScore } from './gallery.js';

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
  /** permanent home of enrolled samples' audio clips (kept until the sample is
   *  deleted) — same data root as the gallery json. */
  readonly clipsDir: string;
  #recent = new Map<string, RecentUtterance[]>();

  constructor(galleryPath: string, clipsDir: string) {
    this.gallery = new VoiceGallery(galleryPath);
    this.clipsDir = clipsDir;
  }

  #deleteClip(clip?: string): void {
    if (!clip || clip.includes('/') || clip.includes('..')) return;
    try { unlinkSync(join(this.clipsDir, clip)); } catch { /* already gone */ }
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
    // The reserved DECOY profile: mislabeled strangers get enrolled as "other"
    // ("not guru" feedback). A voice that matches it best is by definition NOT an
    // enrolled person — label it unknown, never a name, whatever the score.
    if (best.name.trim().toLowerCase() === RESERVED_DECOY) {
      return { name: 'unknown', score: Number(best.score.toFixed(3)), match: false };
    }
    return { name: best.name, score: Number(best.score.toFixed(3)), match: classifyScore(best.score) === 'match' };
  }

  /** Recent utterances for the enroll UI (embedding omitted — big and irrelevant to the console). */
  recent(dockId: string): Omit<RecentUtterance, 'embedding'>[] {
    return (this.#recent.get(dockId) ?? []).map(({ id, text, durS }) => ({ id, text, durS })).reverse();
  }

  /** Enroll selected recent utterances (by id) under `name`. Each becomes one
   *  gallery sample (transcript + audio clip kept as provenance; the clip is copied
   *  from the bounded utterance-audio dump into permanent storage and lives until
   *  the sample is deleted). Near-identical re-enrollments are DEDUPED by the
   *  gallery. Returns { enrolled, duplicates }. */
  enrollFromRecent(dockId: string, name: string, ids: number[]): { enrolled: number; duplicates: number } {
    const ring = this.#recent.get(dockId) ?? [];
    let enrolled = 0, duplicates = 0;
    for (const id of ids) {
      const u = ring.find((r) => r.id === id);
      if (!u) continue;
      // Copy the clip FIRST: the gallery record must never reference a file that
      // failed to land (a dangling clip renders a dead ▶ forever). Filename carries
      // the dock — startedAtMs is only unique per dock.
      const src = utteranceWavPath(dockId, id);
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'voice';
      let clip: string | undefined;
      if (existsSync(src)) {
        try {
          mkdirSync(this.clipsDir, { recursive: true });
          clip = `${slug}-${dockId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}.wav`;
          copyFileSync(src, join(this.clipsDir, clip));
        } catch { clip = undefined; /* clip is provenance, not correctness */ }
      }
      const r = this.gallery.enroll(name, u.embedding, u.text, true, clip);
      if (!r.added) { duplicates++; this.#deleteClip(clip); continue; } // dup: drop the just-copied clip
      enrolled++;
      this.#deleteClip(r.dropped?.clip); // cap-evicted sample takes its clip with it
    }
    return { enrolled, duplicates };
  }

  /** Delete one sample (and its permanent clip). */
  removeSample(name: string, index: number): boolean {
    const removed = this.gallery.removeSample(name, index);
    if (removed) this.#deleteClip(removed.clip);
    return !!removed;
  }

  /** Forget a person entirely (and all their clips). */
  removePerson(name: string): boolean {
    for (const s of this.gallery.samplesOf(name)) this.#deleteClip(s.clip);
    return this.gallery.remove(name);
  }
}
