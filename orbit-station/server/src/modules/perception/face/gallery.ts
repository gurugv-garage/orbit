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
  name: string;
  /** one or more enrolled descriptors for this person (averaged for matching). */
  descriptors: number[][];
  enrolledAt: number;
}

export interface MatchResult {
  name: string;
  /** euclidean distance to the nearest enrolled descriptor (lower = closer). */
  distance: number;
}

/** face-api's default same-person threshold. */
export const MATCH_THRESHOLD = 0.6;

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
   * Enroll a face under `name`. By default this OVERWRITES any prior descriptors
   * for that name (the agent-driven "remember this is X" replaces, doesn't pile
   * on — and avoids same-face-two-names flip-flop). Pass `append` to keep prior
   * angles. Persists immediately.
   */
  enroll(name: string, descriptor: number[], append = false): void {
    const e = append
      ? (this.#people.get(name) ?? { name, descriptors: [], enrolledAt: Date.now() })
      : { name, descriptors: [], enrolledAt: Date.now() };
    e.descriptors.push(descriptor);
    if (e.descriptors.length > 5) e.descriptors.shift();
    this.#people.set(name, e);
    this.#save();
  }

  remove(name: string): boolean {
    const had = this.#people.delete(name);
    if (had) this.#save();
    return had;
  }

  names(): string[] { return [...this.#people.keys()]; }
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
      for (const e of raw) this.#people.set(e.name, e);
    } catch { /* corrupt gallery → start empty */ }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify([...this.#people.values()], null, 2));
  }
}
