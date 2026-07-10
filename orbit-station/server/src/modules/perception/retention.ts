/**
 * Perception retention — the durable, time-windowed backing for the snapshot store
 * (docs/perception-pipeline.md §7c). Perception is the enriched, durable TRUTH; this keeps it
 * on disk so it survives restarts and gaps, and so consumers (introspection, grounding) can
 * read "everything since timestamp T", not just a volatile in-memory tail.
 *
 * Design (deliberately simple — storage is cheap; consumption is the real constraint, §7c):
 *   • append-only JSONL per dock, day-bucketed:  .data/perception/records/<dock>/<YYYY-MM-DD>.jsonl
 *   • on boot: load the recent tail (records within RETAIN_MS) back into the ring, so a
 *     restart doesn't amnesia-wipe the dock's recent perception.
 *   • time-based trim: a background sweep drops day-files older than RETAIN_MS (the trim-time
 *     self-summarization from §7c hangs off this seam — see summarizeTrimmedSpan, wired later).
 *   • KEYFRAMES (base64 JPEGs) are NOT persisted here — heavy, and text is the durable signal
 *     (§7c: keyframes may retain shorter). They stay in the in-memory ring only.
 *
 * Restart/gap-tolerant by construction: appends are idempotent-enough (a duplicate on a
 * crash-replay is harmless — consumers reconcile, they don't tally), and a time gap is just a
 * hole in the JSONL, which reads back fine.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotRecord } from './snapshots.js';

const ROOT = '.data/perception/records';
/** How long raw perception is retained on disk. Storage is cheap → generous default (6 h);
 *  the *consumption* budget (how much a reader feeds an LLM) is capped separately, at read
 *  time (§7c). Env-tunable. */
const RETAIN_MS = Number(process.env.PERCEPTION_RETAIN_MS ?? 6 * 3600_000);
/** Persistence is opt-outable (tests / ephemeral runs). */
const ENABLED = process.env.PERCEPTION_PERSIST !== '0';

const dockDir = (dock: string) => join(ROOT, dock);
const dayFile = (dock: string, iso: string) => join(dockDir(dock), `${iso.slice(0, 10)}.jsonl`);

/** Append one record to the dock's day-bucketed JSONL (best-effort; a write failure must not
 *  break the live pipeline — perception keeps flowing, we just lose durability for that record). */
export function persistRecord(rec: SnapshotRecord): void {
  if (!ENABLED) return;
  try {
    mkdirSync(dockDir(rec.dockId), { recursive: true });
    appendFileSync(dayFile(rec.dockId, rec.interval.from), JSON.stringify(rec) + '\n');
  } catch { /* durability is best-effort; never break the live add() */ }
}

/** Load the recent tail (records whose start is within `withinMs` of `nowMs`) for a dock, so a
 *  restart restores recent perception into the ring. Reads only the day-files that could hold
 *  in-window records. Ascending by interval.from. */
export function loadRecent(dock: string, nowMs: number, withinMs = RETAIN_MS): SnapshotRecord[] {
  if (!ENABLED || !existsSync(dockDir(dock))) return [];
  const cutoffIso = new Date(nowMs + 5.5 * 3600_000 - withinMs).toISOString(); // IST-ish cutoff for string compare
  const out: SnapshotRecord[] = [];
  const days = readdirSync(dockDir(dock)).filter((f) => f.endsWith('.jsonl')).sort();
  // only days >= the cutoff day can contain in-window records
  const cutoffDay = cutoffIso.slice(0, 10);
  for (const f of days) {
    if (f.slice(0, 10) < cutoffDay) continue;
    for (const line of readFileSync(join(dockDir(dock), f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SnapshotRecord;
        if (r.interval?.from >= cutoffIso) out.push(r);
      } catch { /* skip a torn line (crash mid-append) */ }
    }
  }
  out.sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0));
  return out;
}

/** Read all persisted records for a dock whose start is at/after `sinceIso` — the durable
 *  "span since T" the introspection checkpoint reads (may reach back further than the ring). */
export function recordsSince(dock: string, sinceIso: string): SnapshotRecord[] {
  if (!ENABLED || !existsSync(dockDir(dock))) return [];
  const out: SnapshotRecord[] = [];
  const sinceDay = sinceIso.slice(0, 10);
  for (const f of readdirSync(dockDir(dock)).filter((x) => x.endsWith('.jsonl')).sort()) {
    if (f.slice(0, 10) < sinceDay) continue;
    for (const line of readFileSync(join(dockDir(dock), f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SnapshotRecord;
        if (r.interval?.from >= sinceIso) out.push(r);
      } catch { /* skip torn line */ }
    }
  }
  out.sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0));
  return out;
}

/** Trim: delete day-files entirely older than the retention window. Returns the docks whose
 *  data changed (so the caller can trigger trim-time self-summarization — §7c step 2 — before
 *  the raw is gone). Called on a slow sweep. */
export function trimOldDays(nowMs: number): string[] {
  if (!ENABLED || !existsSync(ROOT)) return [];
  const cutoffDay = new Date(nowMs + 5.5 * 3600_000 - RETAIN_MS).toISOString().slice(0, 10);
  const touched: string[] = [];
  for (const dock of readdirSync(ROOT)) {
    const dir = dockDir(dock);
    let changed = false;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      if (f.slice(0, 10) < cutoffDay) {
        try { unlinkSync(join(dir, f)); changed = true; } catch { /* */ }
      }
    }
    if (changed) touched.push(dock);
  }
  return touched;
}

export const retentionPaths = { ROOT, dockDir, dayFile };
export const retentionConfig = { RETAIN_MS, ENABLED };
