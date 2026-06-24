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

/** Canonical DISPLAY casing — Title Case, so the same person always shows the same
 *  way no matter what case was typed ("GURU"/"guru " → "Guru"). The match `key` is
 *  what enforces identity; this is purely how the name is rendered everywhere. */
const displayName = (name: string) =>
  name.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

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
 * TENTATIVE band: between MATCH and this, the dock hedges ("are you X?") and a
 * yes triggers confirm_face → another enrolled sample → recognition improves.
 * Deliberately WIDE (different people sit >0.8 apart): a narrow band (0.66) made
 * the dock cold-shoulder people it half-knew instead of asking, so the
 * confirm/learn loop never ran. This is THE single definition — every
 * recognition path (photo + legacy stream) classifies with [classifyDistance].
 */
export const TENTATIVE_THRESHOLD = 0.75;

export type MatchVerdict = 'confident' | 'tentative' | 'none';

/**
 * Classify a match distance into the dock's categorical verdict. The dock acts
 * on THIS (it must never re-threshold a raw distance/confidence — doing that
 * with `1 - distance` vs an unrelated 0.45 cutoff is what made every confident
 * match read as "not sure" in the prompt).
 */
export function classifyDistance(distance: number): MatchVerdict {
  if (distance <= MATCH_THRESHOLD) return 'confident';
  if (distance <= TENTATIVE_THRESHOLD) return 'tentative';
  return 'none';
}

/**
 * Bring an on-disk entry up to the current shape. New entries have `samples`;
 * legacy ones have `descriptors[]` + a single shared `photo` — we zip them into
 * samples (the one photo goes on the first descriptor; the rest are photo-less,
 * which the console renders as a "no photo" placeholder).
 */
function migrate(e: GalleryEntry | LegacyEntry): GalleryEntry {
  // Normalize the display name to canonical casing on the way in (so old entries
  // saved with arbitrary casing render consistently everywhere).
  if (Array.isArray((e as GalleryEntry).samples)) {
    const g = e as GalleryEntry;
    return { ...g, name: displayName(g.name) };
  }
  const legacy = e as LegacyEntry;
  const descriptors = legacy.descriptors ?? [];
  const samples: FaceSample[] = descriptors.map((descriptor, i) => ({
    descriptor,
    photo: i === 0 ? legacy.photo : undefined,
    addedAt: legacy.enrolledAt ?? Date.now(),
  }));
  return { name: displayName(legacy.name), samples, enrolledAt: legacy.enrolledAt ?? Date.now() };
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
      : { name: displayName(name), samples: [], enrolledAt: Date.now() };
    // Canonical display casing; an existing person keeps their established name
    // (typing a different case just appends, it doesn't rewrite the display).
    e.name = prev?.name ?? displayName(name);
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
   * Move ONE sample (by index) from `from` to person `to` — i.e. "this photo is
   * actually someone else". Creates `to` if new, merges if existing (cap 5). If
   * `from` is left empty it's removed. Case-insensitive on both names.
   * Returns { ok, removedSource } (removedSource = `from` had no samples left).
   */
  reassignSample(from: string, index: number, to: string): { ok: boolean; removedSource: boolean } {
    const src = this.#people.get(key(from));
    if (!src || index < 0 || index >= src.samples.length || !to.trim()) return { ok: false, removedSource: false };
    const [sample] = src.samples.splice(index, 1);
    const toK = key(to);
    const dest = this.#people.get(toK) ?? { name: displayName(to), samples: [], enrolledAt: Date.now() };
    dest.samples = [...dest.samples, sample!].slice(-5);
    this.#people.set(toK, dest);
    let removedSource = false;
    if (src.samples.length === 0) { this.#people.delete(key(from)); removedSource = true; }
    this.#save();
    return { ok: true, removedSource };
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

  /**
   * Rename a person. Case-insensitive on both sides. If `to` already exists (a
   * different person, case-insensitively), the two are MERGED — `from`'s samples
   * fold into `to` (capped at 5, newest kept). No-op if `from` doesn't exist or the
   * names are the same key. Returns { ok, merged }.
   */
  rename(from: string, to: string): { ok: boolean; merged: boolean } {
    const fromK = key(from), toK = key(to);
    const e = this.#people.get(fromK);
    if (!e || !to.trim()) return { ok: false, merged: false };
    if (fromK === toK) { e.name = displayName(to); this.#save(); return { ok: true, merged: false }; }
    const target = this.#people.get(toK);
    if (target) {
      // merge from→target, newest samples win, cap 5
      target.samples = [...target.samples, ...e.samples].slice(-5);
      this.#people.delete(fromK);
    } else {
      e.name = displayName(to);
      this.#people.delete(fromK);
      this.#people.set(toK, e);
    }
    this.#save();
    return { ok: true, merged: !!target };
  }

  /** Display names (canonical Title Case). */
  names(): string[] { return [...this.#people.values()].map((e) => e.name); }

  /** Whether `name` is already enrolled (case/space-insensitive). */
  has(name: string): boolean { return this.#people.has(key(name)); }
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
   * Prune samples. Always drops CORRUPT ones (descriptor missing or not the 128-d
   * face-api vector — they can never match). With `dropPhotoless`, also drops valid
   * descriptors that have NO photo (the pre-fix confirmations) — they keep working
   * for matching but can't be shown; removing them trades a little recognition
   * robustness for a gallery where every sample is viewable. A person left with zero
   * samples is removed. Returns how many samples + people were pruned.
   */
  clean(dropPhotoless = false): { samples: number; people: number } {
    let samples = 0, people = 0;
    for (const [k, e] of [...this.#people]) {
      const before = e.samples.length;
      e.samples = e.samples.filter((s) =>
        Array.isArray(s.descriptor) && s.descriptor.length === 128 && (!dropPhotoless || !!s.photo));
      samples += before - e.samples.length;
      if (e.samples.length === 0) { this.#people.delete(k); people++; }
    }
    if (samples || people) this.#save();
    return { samples, people };
  }

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
