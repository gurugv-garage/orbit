/**
 * Snapshot TAKES — freeze a window of live perception (records + keyframes) to disk
 * as a named bundle, so the same FIXED data can be re-summarized later with a
 * different prompt / model / keyframe setting. This is the A/B harness: the live
 * ring keeps sliding, but a take is immutable, so "old vs new" comparisons are
 * apples-to-apples (same input, varied summarizer).
 *
 * One JSON file per take under data/perception-takes/<slug>.json:
 *   { name, savedAt, range:{from,to}, counts, records:[…], keyframes:[b64…] }
 *
 * Keyframes are base64 JPEGs (big) but a take is a deliberate, bounded capture —
 * not the live ring — so we accept the size for replay fidelity.
 */

import { fileURLToPath } from 'node:url';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotRecord } from './snapshots.js';

const TAKES_DIR = fileURLToPath(new URL('../../../data/perception-takes/', import.meta.url));

export interface Take {
  name: string;
  savedAt: string;                       // IST ISO
  range: { from: string; to: string };   // first/last record (IST)
  counts: { vision: number; speech: number; identity: number; emotion: number; bodymotion: number; keyframes: number };
  records: SnapshotRecord[];
  keyframes: string[];                   // base64 JPEG, in order
}

/** A take's metadata only — for the list view (no heavy records/keyframes). */
export type TakeMeta = Omit<Take, 'records' | 'keyframes'>;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'take';
}
function pathFor(name: string): string {
  return join(TAKES_DIR, `${slug(name)}.json`);
}
function counts(records: SnapshotRecord[], keyframes: string[]): Take['counts'] {
  const by = (k: string) => records.filter((r) => r.source.kind === k).length;
  return { vision: by('vision'), speech: by('speech'), identity: by('identity'),
    emotion: by('emotion'), bodymotion: by('bodymotion'), keyframes: keyframes.length };
}

/** Disk-backed store of saved takes. Cheap: list reads metadata, load reads one file. */
export class TakeStore {
  constructor() { mkdirSync(TAKES_DIR, { recursive: true }); }

  /** Persist a named bundle of records + keyframes. Overwrites a same-named take. */
  save(name: string, records: SnapshotRecord[], keyframes: string[]): TakeMeta {
    const from = records[0]?.interval.from ?? '';
    const to = records[records.length - 1]?.interval.to ?? '';
    const take: Take = {
      name: name.trim() || 'take',
      savedAt: new Date().toISOString(),
      range: { from, to },
      counts: counts(records, keyframes),
      records, keyframes,
    };
    writeFileSync(pathFor(take.name), JSON.stringify(take));
    return meta(take);
  }

  /** All saved takes' metadata, newest first. */
  list(): TakeMeta[] {
    if (!existsSync(TAKES_DIR)) return [];
    const out: TakeMeta[] = [];
    for (const f of readdirSync(TAKES_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(readFileSync(join(TAKES_DIR, f), 'utf8')) as Take;
        out.push(meta(t));
      } catch { /* skip corrupt */ }
    }
    return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }

  /** Load one full take (records + keyframes) by name, or null if missing. */
  load(name: string): Take | null {
    const p = pathFor(name);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as Take; } catch { return null; }
  }

  delete(name: string): boolean {
    const p = pathFor(name);
    if (!existsSync(p)) return false;
    try { unlinkSync(p); return true; } catch { return false; }
  }
}

function meta(t: Take): TakeMeta {
  return { name: t.name, savedAt: t.savedAt, range: t.range, counts: t.counts };
}
