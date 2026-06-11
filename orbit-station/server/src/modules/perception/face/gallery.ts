/**
 * Face gallery — the set of known people as named 128-d face descriptors
 * (face-api's FaceRecognitionNet output). Persisted as one JSON file so enrolled
 * faces survive restarts; matching is nearest-neighbour by euclidean distance
 * (face-api's convention; < ~0.6 = same person).
 *
 * Pure data + math (no face-api, no tf) so it unit-tests without models.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One enrolled face capture: the 128-d descriptor used for matching, paired with
 * the photo it came from so the console can SHOW what the recognizer remembers
 * (and let you delete a bad one). Fingerprint and photo are 1:1.
 */
export interface FaceSample {
  /** the 128-d face-api descriptor — what matching actually compares. */
  descriptor: number[];
  /** the JPEG (base64) this descriptor was computed from, for the console. */
  photo?: string;
  addedAt: number;
}

export interface GalleryEntry {
  /** display name as the user typed it ("Guru"); matched case-insensitively. */
  name: string;
  /** the person's enrolled captures (each = one descriptor + its own photo). */
  samples: FaceSample[];
  enrolledAt: number;
}

/** Legacy on-disk shape (descriptors[] + a single shared photo) we migrate from. */
interface LegacyEntry {
  name: string;
  descriptors?: number[][];
  photo?: string;
  enrolledAt?: number;
}

/** Names are matched case/space-insensitively ("Guru" == "guru " == "GURU"). */
const key = (name: string) => name.trim().toLowerCase();

export interface MatchResult {
  name: string;
  /** euclidean distance to the nearest enrolled descriptor (lower = closer). */
  distance: number;
}

/**
 * Same-person distance threshold. face-api's default is 0.6, but that's tuned for
 * clean front-facing photos; our frames are a low-res ~2fps webcam-ish stream at
 * an angle, so genuine same-person distances run a bit higher (~0.5-0.6). 0.62
 * gives a little headroom so a true match on a slightly-off frame still passes,
 * without letting strangers in (different people are typically >0.8 apart).
 */
export const MATCH_THRESHOLD = 0.62;

/**
 * Bring an on-disk entry up to the current shape. New entries have `samples`;
 * legacy ones have `descriptors[]` + a single shared `photo` — we zip them into
 * samples (the one photo goes on the first descriptor; the rest are photo-less,
 * which the console renders as a "no photo" placeholder).
 */
function migrate(e: GalleryEntry | LegacyEntry): GalleryEntry {
  if (Array.isArray((e as GalleryEntry).samples)) return e as GalleryEntry;
  const legacy = e as LegacyEntry;
  const descriptors = legacy.descriptors ?? [];
  const samples: FaceSample[] = descriptors.map((descriptor, i) => ({
    descriptor,
    photo: i === 0 ? legacy.photo : undefined,
    addedAt: legacy.enrolledAt ?? Date.now(),
  }));
  return { name: legacy.name, samples, enrolledAt: legacy.enrolledAt ?? Date.now() };
}

export function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; s += d * d; }
  return Math.sqrt(s);
}

export class Gallery {
  #path: string;
  #people = new Map<string, GalleryEntry>();

  constructor(path: string) {
    this.#path = path;
    this.#load();
  }

  /**
   * Enroll a face under `name` (case-insensitive — "Guru" and "guru" are the same
   * person). Stores ONE sample: the descriptor paired with the photo it came from.
   *   - append=false ("remember this is X"): replace all of X's prior samples.
   *   - append=true  ("yes that's me"): add another angle (capped at 5, oldest
   *     dropped) so recognition gets more robust.
   */
  enroll(name: string, descriptor: number[], photo?: string, append = false): void {
    const k = key(name);
    const prev = this.#people.get(k);
    const e: GalleryEntry = append && prev
      ? prev
      : { name: name.trim(), samples: [], enrolledAt: Date.now() };
    e.name = name.trim(); // refresh display name to the latest casing
    e.samples.push({ descriptor, photo, addedAt: Date.now() });
    if (e.samples.length > 5) e.samples.shift();
    this.#people.set(k, e);
    this.#save();
  }

  remove(name: string): boolean {
    const had = this.#people.delete(key(name));
    if (had) this.#save();
    return had;
  }

  /**
   * Delete one enrolled sample (fingerprint+photo) by its index. If it was the
   * last sample for that person, the person is removed entirely.
   * Returns true if something was removed.
   */
  removeSample(name: string, index: number): boolean {
    const e = this.#people.get(key(name));
    if (!e || index < 0 || index >= e.samples.length) return false;
    e.samples.splice(index, 1);
    if (e.samples.length === 0) this.#people.delete(key(name));
    this.#save();
    return true;
  }

  /** Display names (original casing). */
  names(): string[] { return [...this.#people.values()].map((e) => e.name); }
  /**
   * Per-person samples for the console: each person + their enrolled captures
   * (index + photo), so the UI can show what's stored and target one for deletion.
   */
  people(): { name: string; samples: { index: number; photo?: string }[] }[] {
    return [...this.#people.values()].map((e) => ({
      name: e.name,
      samples: e.samples.map((s, index) => ({ index, photo: s.photo })),
    }));
  }
  size(): number { return this.#people.size; }

  /**
   * Best match for a query descriptor, or null if the gallery is empty or no one
   * is within `threshold`. Distance is to the nearest enrolled descriptor.
   */
  match(descriptor: number[], threshold = MATCH_THRESHOLD): MatchResult | null {
    let best: MatchResult | null = null;
    for (const e of this.#people.values()) {
      for (const s of e.samples) {
        const dist = euclidean(descriptor, s.descriptor);
        if (!best || dist < best.distance) best = { name: e.name, distance: dist };
      }
    }
    return best && best.distance <= threshold ? best : null;
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf-8')) as (GalleryEntry | LegacyEntry)[];
      let changed = false;
      for (const rawEntry of raw) {
        const e = migrate(rawEntry);
        if (e !== rawEntry) changed = true; // migrated from the legacy shape
        const k = key(e.name);
        const prev = this.#people.get(k);
        if (prev) {
          // merge case-dupes ("Guru" + "guru"): combine samples, keep newest 5.
          prev.samples = [...prev.samples, ...e.samples].slice(-5);
          changed = true;
        } else {
          this.#people.set(k, e);
        }
      }
      if (changed) this.#save(); // persist migration + de-dup
    } catch { /* corrupt gallery → start empty */ }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify([...this.#people.values()], null, 2));
  }
}
