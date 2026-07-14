/**
 * Voice gallery — known people as named speaker embeddings (the STT sidecar's
 * TitaNet output via sherpa-onnx, unit-norm 192-d). The audio twin of
 * face/gallery.ts: persisted as one JSON file, matched against enrolled samples —
 * but by COSINE similarity (speaker-embedding convention; higher = closer),
 * where faces use euclidean distance (lower = closer).
 *
 * Pure data + math (no sherpa, no sidecar) so it unit-tests without models.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One enrolled utterance: the embedding used for matching, paired with the
 * transcript it came from so the console can SHOW what the recognizer remembers
 * (the audio analog of the face sample's photo).
 */
export interface VoiceSample {
  embedding: number[];
  /** what parakeet heard in the enrolled utterance, for the console. */
  text?: string;
  addedAt: number;
}

export interface VoiceEntry {
  /** display name as the user typed it ("Guru"); matched case-insensitively. */
  name: string;
  samples: VoiceSample[];
  enrolledAt: number;
}

/** Names are matched case/space-insensitively ("Guru" == "guru " == "GURU"). */
const key = (name: string) => name.trim().toLowerCase();
const displayName = (name: string) =>
  name.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export interface VoiceMatch {
  name: string;
  /** cosine similarity to the nearest enrolled embedding (higher = closer). */
  score: number;
}

/**
 * Thresholds from the 2026-07-14 trial on real far-field dock audio (TitaNet via
 * sherpa-onnx): same-speaker utterances scored 0.59–0.77 against a single-utterance
 * profile; different speakers ~0.0 (max observed 0.15 under torch-ECAPA, ~0.01 under
 * TitaNet). ≥ MATCH → name the speaker; < REJECT → confidently someone else
 * ("other"); between → "unknown" (say nothing rather than guess). Env-tunable while
 * the trial calibrates them.
 */
export const VOICE_MATCH = Number(process.env.VOICE_MATCH ?? 0.4);
export const VOICE_REJECT = Number(process.env.VOICE_REJECT ?? 0.25);

export type VoiceVerdict = 'match' | 'unknown' | 'other';

export function classifyScore(score: number): VoiceVerdict {
  if (score >= VOICE_MATCH) return 'match';
  if (score < VOICE_REJECT) return 'other';
  return 'unknown';
}

/** Cosine similarity. Embeddings arrive unit-norm from the sidecar, but normalize
 *  anyway so a hand-edited or legacy gallery entry can't skew scores. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

const SAMPLE_CAP = 8;

export class VoiceGallery {
  #path: string;
  #people = new Map<string, VoiceEntry>();

  constructor(path: string) {
    this.#path = path;
    this.#load();
  }

  /**
   * Enroll an utterance under `name` (case-insensitive). append=true adds another
   * sample (capped at SAMPLE_CAP, oldest dropped); append=false replaces the
   * person's prior samples.
   */
  enroll(name: string, embedding: number[], text?: string, append = true): void {
    const k = key(name);
    const prev = this.#people.get(k);
    const e: VoiceEntry = append && prev
      ? prev
      : { name: displayName(name), samples: [], enrolledAt: Date.now() };
    e.name = prev?.name ?? displayName(name);
    e.samples.push({ embedding, text, addedAt: Date.now() });
    if (e.samples.length > SAMPLE_CAP) e.samples.shift();
    this.#people.set(k, e);
    this.#save();
  }

  remove(name: string): boolean {
    const had = this.#people.delete(key(name));
    if (had) this.#save();
    return had;
  }

  /** Delete one sample by index; the person goes with their last sample. */
  removeSample(name: string, index: number): boolean {
    const e = this.#people.get(key(name));
    if (!e || index < 0 || index >= e.samples.length) return false;
    e.samples.splice(index, 1);
    if (e.samples.length === 0) this.#people.delete(key(name));
    this.#save();
    return true;
  }

  names(): string[] { return [...this.#people.values()].map((e) => e.name); }
  has(name: string): boolean { return this.#people.has(key(name)); }
  size(): number { return this.#people.size; }

  /** Per-person samples for the console (index + the enrolled transcript). */
  people(): { name: string; samples: { index: number; text?: string; addedAt: number }[] }[] {
    return [...this.#people.values()].map((e) => ({
      name: e.name,
      samples: e.samples.map((s, index) => ({ index, text: s.text, addedAt: s.addedAt })),
    }));
  }

  /**
   * Best match for an embedding: nearest enrolled sample by cosine. Returns the
   * best candidate WITH its score even below threshold — the caller classifies via
   * [classifyScore] (match/unknown/other), mirroring how the face path routes every
   * decision through classifyDistance.
   */
  match(embedding: number[]): VoiceMatch | null {
    let best: VoiceMatch | null = null;
    for (const e of this.#people.values()) {
      for (const s of e.samples) {
        const score = cosine(embedding, s.embedding);
        if (!best || score > best.score) best = { name: e.name, score };
      }
    }
    return best;
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf-8')) as VoiceEntry[];
      for (const e of raw) {
        const k = key(e.name);
        const prev = this.#people.get(k);
        if (prev) {
          prev.samples = [...prev.samples, ...e.samples].slice(-SAMPLE_CAP);
        } else {
          this.#people.set(k, { ...e, name: displayName(e.name) });
        }
      }
    } catch { /* corrupt gallery → start empty */ }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify([...this.#people.values()], null, 2));
  }
}
