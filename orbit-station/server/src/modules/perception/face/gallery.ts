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

export interface GalleryEntry {
  /** display name as the user typed it ("Guru"); matched case-insensitively. */
  name: string;
  /** one or more enrolled descriptors for this person (averaged for matching). */
  descriptors: number[][];
  /** small JPEG of the enrolled face, base64 (for the console). Optional. */
  photo?: string;
  enrolledAt: number;
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
   * person). OVERWRITES any prior descriptors for that name by default ("remember
   * this is X" replaces). `photo` is an optional base64 JPEG thumbnail.
   */
  enroll(name: string, descriptor: number[], photo?: string, append = false): void {
    const k = key(name);
    const prev = this.#people.get(k);
    const e: GalleryEntry = append && prev
      ? prev
      : { name: name.trim(), descriptors: [], enrolledAt: Date.now() };
    e.name = name.trim(); // refresh display name to the latest casing
    e.descriptors.push(descriptor);
    if (e.descriptors.length > 5) e.descriptors.shift();
    if (photo) e.photo = photo;
    this.#people.set(k, e);
    this.#save();
  }

  remove(name: string): boolean {
    const had = this.#people.delete(key(name));
    if (had) this.#save();
    return had;
  }

  /** Display names (original casing). */
  names(): string[] { return [...this.#people.values()].map((e) => e.name); }
  /** Names + photo thumbnails for the console. */
  people(): { name: string; photo?: string }[] {
    return [...this.#people.values()].map((e) => ({ name: e.name, photo: e.photo }));
  }
  size(): number { return this.#people.size; }

  /**
   * Best match for a query descriptor, or null if the gallery is empty or no one
   * is within `threshold`. Distance is to the nearest enrolled descriptor.
   */
  match(descriptor: number[], threshold = MATCH_THRESHOLD): MatchResult | null {
    let best: MatchResult | null = null;
    for (const e of this.#people.values()) {
      for (const d of e.descriptors) {
        const dist = euclidean(descriptor, d);
        if (!best || dist < best.distance) best = { name: e.name, distance: dist };
      }
    }
    return best && best.distance <= threshold ? best : null;
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf-8')) as GalleryEntry[];
      let merged = false;
      for (const e of raw) {
        const k = key(e.name);
        const prev = this.#people.get(k);
        if (prev) {
          // merge case-dupes ("Guru" + "guru"): combine descriptors, keep a photo.
          prev.descriptors = [...prev.descriptors, ...e.descriptors].slice(-5);
          prev.photo ??= e.photo;
          merged = true;
        } else {
          this.#people.set(k, e);
        }
      }
      if (merged) this.#save(); // persist the de-duplicated gallery
    } catch { /* corrupt gallery → start empty */ }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify([...this.#people.values()], null, 2));
  }
}
