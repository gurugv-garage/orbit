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
 *   • time-based trim + SELF-COMPRESS: a background sweep (selfCompressAndTrim) compresses records
 *     older than RETAIN_MS into durable span-summaries BEFORE removing them (at record granularity,
 *     incl. the aged tail of today's file), so the timeline compresses but never has a hole (§7c).
 *   • KEYFRAMES (base64 JPEGs) are NOT persisted here — heavy, and text is the durable signal
 *     (§7c: keyframes may retain shorter). They stay in the in-memory ring only.
 *
 * Restart/gap-tolerant by construction: appends are idempotent-enough (a duplicate on a
 * crash-replay is harmless — consumers reconcile, they don't tally), and a time gap is just a
 * hole in the JSONL, which reads back fine.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotRecord } from './snapshots.js';
import { dataPath } from '../../core/data-dir.js';

const ROOT = dataPath('perception', 'records');
/** How long raw perception is retained on disk. Storage is cheap → generous default (6 h);
 *  the *consumption* budget (how much a reader feeds an LLM) is capped separately, at read
 *  time (§7c). Env-tunable. */
const RETAIN_MS = Number(process.env.PERCEPTION_RETAIN_MS ?? 6 * 3600_000);
/** How long the SELF-COMPRESSED tail (span-summaries) is retained — much longer than raw, since
 *  it's tiny and IS the dock's older memory. Beyond this the older self even forgets the digest.
 *  Default 30 days. §7c: "store liberally by time." */
const SUMMARY_RETAIN_MS = Number(process.env.PERCEPTION_SUMMARY_RETAIN_MS ?? 30 * 24 * 3600_000);
/** Persistence is opt-outable (tests / ephemeral runs). */
const ENABLED = process.env.PERCEPTION_PERSIST !== '0';

const dockDir = (dock: string) => join(ROOT, dock);
const dayFile = (dock: string, iso: string) => join(dockDir(dock), `${iso.slice(0, 10)}.jsonl`);
/** The self-compressed tail lives in ONE append-only file per dock, kept OUT of the day-file
 *  glob so the raw-trim sweep never touches it — it's part of the same perception stream, just
 *  the older, lossy fidelity (§7c: "one stream, two fidelities"). */
const summaryFile = (dock: string) => join(dockDir(dock), 'span-summaries.jsonl');
/** Only day-files are RAW records; `span-summaries.jsonl` is the compressed tail and must be
 *  excluded from raw reads/trims. A day-file name is `YYYY-MM-DD.jsonl`. */
const isDayFile = (f: string) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f);

/** Append one record to the dock's day-bucketed JSONL (best-effort; a write failure must not
 *  break the live pipeline — perception keeps flowing, we just lose durability for that record). */
export function persistRecord(rec: SnapshotRecord): void {
  if (!ENABLED) return;
  try {
    mkdirSync(dockDir(rec.dockId), { recursive: true });
    appendFileSync(dayFile(rec.dockId, rec.interval.from), JSON.stringify(rec) + '\n');
  } catch { /* durability is best-effort; never break the live add() */ }
}

/** The reconcile key for a record: an utterance/snapshot is uniquely identified by its start
 *  time + producing source. The SAME key `hydrate` uses to de-dup the ring on boot. */
const recKey = (r: SnapshotRecord) => `${r.interval?.from}|${r.source?.id}|${r.source?.kind}`;

/** Last-wins reconcile over an append-only, time-sorted record list: a record that was ENRICHED
 *  after first write (enricher re-append) appears twice; keep the LAST occurrence (the
 *  patched one). Input MUST be ascending by interval.from (both readers sort before calling), so
 *  the later line for a key is the enriched one. Preserves order; O(n). */
function dedupeLastWins(recs: SnapshotRecord[]): SnapshotRecord[] {
  const lastIdx = new Map<string, number>();
  recs.forEach((r, i) => lastIdx.set(recKey(r), i));
  return recs.filter((r, i) => lastIdx.get(recKey(r)) === i);
}

/** Load the recent tail (records whose start is within `withinMs` of `nowMs`) for a dock, so a
 *  restart restores recent perception into the ring. Reads only the day-files that could hold
 *  in-window records. Ascending by interval.from, last-wins reconciled. */
export function loadRecent(dock: string, nowMs: number, withinMs = RETAIN_MS): SnapshotRecord[] {
  if (!ENABLED || !existsSync(dockDir(dock))) return [];
  const cutoffIso = new Date(nowMs + 5.5 * 3600_000 - withinMs).toISOString(); // IST-ish cutoff for string compare
  const out: SnapshotRecord[] = [];
  const days = readdirSync(dockDir(dock)).filter(isDayFile).sort();
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
  return dedupeLastWins(out);
}

/** Read all persisted records for a dock whose start is at/after `sinceIso` — the durable
 *  "span since T" the introspection checkpoint reads (may reach back further than the ring).
 *  Last-wins reconciled so an enriched (re-appended) record shows only its patched version. */
export function recordsSince(dock: string, sinceIso: string): SnapshotRecord[] {
  if (!ENABLED || !existsSync(dockDir(dock))) return [];
  const out: SnapshotRecord[] = [];
  const sinceDay = sinceIso.slice(0, 10);
  for (const f of readdirSync(dockDir(dock)).filter(isDayFile).sort()) {
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
  return dedupeLastWins(out);
}

/** Read the self-compressed tail (span-summaries) whose span STARTS at/after `sinceIso`. These
 *  are `kind:'summary'` records — perception at its older, lossy fidelity (§7c). */
export function spanSummariesSince(dock: string, sinceIso: string): SnapshotRecord[] {
  if (!ENABLED) return [];
  const f = summaryFile(dock);
  if (!existsSync(f)) return [];
  const out: SnapshotRecord[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SnapshotRecord;
      // include a summary if its span overlaps [sinceIso, ∞): its span END is at/after sinceIso
      if ((r.interval?.to ?? r.interval?.from) >= sinceIso) out.push(r);
    } catch { /* skip torn line */ }
  }
  out.sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0));
  return out;
}

/** Read persisted records for a dock whose start falls in `[fromIso, toIso]` — the bounded
 *  form of `recordsSince` the console's OFFLINE history view reads (a pinned window over what's
 *  still retained on disk). Raw records only; span-summaries come via `spanSummariesInWindow`. */
export function recordsInWindow(dock: string, fromIso: string, toIso: string): SnapshotRecord[] {
  return recordsSince(dock, fromIso).filter((r) => r.interval.from <= toIso);
}

/** Span-summaries (the compressed older tail) whose span OVERLAPS `[fromIso, toIso]`: it starts
 *  at/before the window end and ends at/after the window start. */
export function spanSummariesInWindow(dock: string, fromIso: string, toIso: string): SnapshotRecord[] {
  return spanSummariesSince(dock, fromIso).filter((r) => r.interval.from <= toIso);
}

/** One dock's on-disk history extent — what the console needs to OFFER it as a selectable source
 *  and bound its time-range picker, without loading the records. Derived cheaply from the day-file
 *  names (the span edges) + a tail read of the newest day (lastSeen) + the summaries file existence.
 *  Returns null for a dock dir with no raw day-files AND no summaries (nothing to show). */
export interface DockHistory {
  dock: string;
  from: string | null;   // earliest retained record day (00:00) — coarse, from the oldest day-file
  to: string | null;     // lastSeen (below) or the newest day — the span's right edge
  lastSeen: string | null; // interval.from of the newest persisted record (fine-grained)
  hasSummaries: boolean; // a span-summaries.jsonl exists (older, compressed fidelity available)
  days: number;          // count of raw day-files retained
  bytes: number;         // on-disk size of this dock's raw day-files + summaries (statSync, no reads).
                         // Surfaced in the console because vision records carry the frames qwen saw
                         // (inputImages/reusedFromB64 base64 JPEGs) → ~99% of the bytes are images, so
                         // a live dock's day-file balloons to 100+MB before the 6h raw-trim reclaims it.
                         // Making the cost visible (it's an intentional debug/review payload, not a leak).
}
export function dockHistory(dock: string): DockHistory | null {
  if (!ENABLED || !existsSync(dockDir(dock))) return null;
  let entries: string[];
  try { entries = readdirSync(dockDir(dock)); } catch { return null; }
  const days = entries.filter(isDayFile).sort();
  const hasSummaries = existsSync(summaryFile(dock));
  if (!days.length && !hasSummaries) return null;
  // The RAW extent, from the day-file names + a tail read of the newest day for lastSeen.
  const rawFrom = days.length ? `${days[0]!.slice(0, 10)}T00:00` : null;
  let lastSeen: string | null = null;
  if (days.length) {
    try {
      const lines = readFileSync(join(dockDir(dock), days[days.length - 1]!), 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && !lastSeen; i--) {
        if (!lines[i]!.trim()) continue;
        try { lastSeen = (JSON.parse(lines[i]!) as SnapshotRecord).interval?.from ?? null; } catch { /* torn line — keep scanning up */ }
      }
    } catch { /* unreadable → leave lastSeen null */ }
  }
  const rawTo = lastSeen ?? (days.length ? `${days[days.length - 1]!.slice(0, 10)}T23:59` : null);
  // The SUMMARY extent (span-summaries.jsonl, appended in time order) — so a dock whose raw has all
  // aged out (summaries-only) still reports a real span, and `from`/`to` cover BOTH fidelities. Else
  // the default history window (rawFrom/rawTo, or a now−6h fallback) would miss the older digests.
  let sumFrom: string | null = null, sumTo: string | null = null;
  if (hasSummaries) {
    try {
      const lines = readFileSync(summaryFile(dock), 'utf8').split('\n').filter((l) => l.trim());
      for (const l of lines) { try { sumFrom = (JSON.parse(l) as SnapshotRecord).interval?.from ?? null; break; } catch { /* torn */ } }
      for (let i = lines.length - 1; i >= 0 && !sumTo; i--) { try { sumTo = (JSON.parse(lines[i]!) as SnapshotRecord).interval?.to ?? null; } catch { /* torn */ } }
    } catch { /* unreadable */ }
  }
  // On-disk size: stat the raw day-files + the summaries file (metadata only, no content read).
  let bytes = 0;
  for (const f of days) { try { bytes += statSync(join(dockDir(dock), f)).size; } catch { /* raced away */ } }
  if (hasSummaries) { try { bytes += statSync(summaryFile(dock)).size; } catch { /* */ } }
  const min = (a: string | null, b: string | null) => a && b ? (a < b ? a : b) : (a ?? b);
  const max = (a: string | null, b: string | null) => a && b ? (a > b ? a : b) : (a ?? b);
  const from = min(rawFrom, sumFrom);
  const to = max(rawTo, sumTo);
  return { dock, from, to, lastSeen: lastSeen ?? sumTo, hasSummaries, days: days.length, bytes };
}

/** Every dock that has ANY on-disk perception history — the directory the console merges with the
 *  set of live producers to build its source selector (so an offline dock is still selectable). */
export function listDockHistory(): DockHistory[] {
  if (!ENABLED || !existsSync(ROOT)) return [];
  let docks: string[];
  try { docks = readdirSync(ROOT); } catch { return []; }
  return docks
    .map((d) => dockHistory(d))
    .filter((h): h is DockHistory => h !== null)
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')); // most-recently-seen first
}

/** The clock-hour bucket key for an IST-ish ISO timestamp: `YYYY-MM-DDTHH`. Span-summaries are
 *  compressed one whole clock-hour at a time (a coherent "memory of 9–10am"), NOT per trim-tick —
 *  fragmenting the tail into tiny slices makes each digest meaningless and, on thin spans, makes
 *  the summarizer hallucinate. So a bucket is compressed only once the whole hour has closed. */
/** Bucket granularity for self-compression. Default = the clock HOUR (`YYYY-MM-DDTHH`), so each
 *  span-summary is a coherent "memory of an hour". Env-tunable to a finer minute-multiple purely
 *  for ACCELERATED TESTING (so buckets close in the soak's wall-clock instead of once per real
 *  hour); production leaves it at the hour. */
const BUCKET_MINUTES = Number(process.env.PERCEPTION_BUCKET_MINUTES ?? 60);
const hourBucket = (iso: string): string => {
  if (BUCKET_MINUTES >= 60) return iso.slice(0, 13); // "2026-07-10T09" — the clock hour
  // finer buckets (testing): floor the minute to a BUCKET_MINUTES boundary
  const min = Number(iso.slice(14, 16));
  const floored = Math.floor(min / BUCKET_MINUTES) * BUCKET_MINUTES;
  return `${iso.slice(0, 14)}${String(floored).padStart(2, '0')}`; // "2026-07-10T09:05"
};

/**
 * Trim + SELF-COMPRESS (§7c step 2), by CLOSED CLOCK-HOUR bucket. Records aged past the retention
 * window are grouped by clock-hour; each hour that is FULLY closed (its end is older than the
 * cutoff, so no more records can land in it) is compressed into ONE durable **span-summary** — a
 * coherent hourly memory — then removed from the raw file. Records in the not-yet-fully-aged hour
 * stay raw until their hour closes. So the timeline compresses hour-by-hour, never fragments, and
 * never has a hole. Self-compression is *perception compressing its own tail*, part of the stream.
 *
 * `summarizeSpan(records)` is injected (the caller wires the Gemini digest) so retention has no
 * dependency on Gemini. Async: an hour's raw is removed ONLY after its summary is durably written —
 * a summarizer failure keeps the raw (retry next sweep), never silent data loss. When no summarizer
 * is wired (tests), aged raw is dropped without a digest (the pre-§7c behaviour). Returns the docks
 * whose data changed.
 */
export async function selfCompressAndTrim(
  nowMs: number,
  summarizeSpan?: (records: SnapshotRecord[]) => Promise<string>,
  onCompressedSpan?: (records: SnapshotRecord[]) => Promise<void>,
): Promise<string[]> {
  if (!ENABLED || !existsSync(ROOT)) return [];
  const cutoffMs = nowMs - RETAIN_MS;
  const cutoffIso = new Date(cutoffMs + 5.5 * 3600_000).toISOString(); // IST-ish, comparable to interval.from
  const cutoffDay = cutoffIso.slice(0, 10);
  // an hour bucket is "closed" (safe to compress) once the START of its NEXT hour is past the
  // cutoff — i.e. bucket < the cutoff's hour bucket. The cutoff's own hour is still open.
  const openBucket = hourBucket(cutoffIso);
  const summaryCutoffIso = new Date(nowMs + 5.5 * 3600_000 - SUMMARY_RETAIN_MS).toISOString();
  const touched: string[] = [];
  for (const dock of readdirSync(ROOT)) {
    const dir = dockDir(dock);
    let changed = false;
    for (const f of readdirSync(dir).filter(isDayFile)) {
      // fast skip: a day-file whose whole day is newer than the cutoff day can't hold old records
      if (f.slice(0, 10) > cutoffDay) continue;
      const path = join(dir, f);
      let lines: string[];
      try { lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()); } catch { continue; }
      const parsed = lines.map((l) => { try { return JSON.parse(l) as SnapshotRecord; } catch { return null; } });
      // group aged-out records by CLOSED clock-hour; everything else stays raw
      const buckets = new Map<string, SnapshotRecord[]>();
      const keepLines: string[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const r = parsed[i];
        const from = r?.interval?.from;
        if (r && from && hourBucket(from) < openBucket) {
          (buckets.get(hourBucket(from)) ?? buckets.set(hourBucket(from), []).get(hourBucket(from))!).push(r);
        } else {
          keepLines.push(lines[i]!); // in-window, in the still-open hour, or a torn line — keep
        }
      }
      if (!buckets.size) continue; // no fully-closed aged hour in this file
      let anyCompressed = false;
      for (const [bkt, recs] of [...buckets.entries()].sort()) {
        // last-wins reconcile within the hour: an enriched (re-appended) record is present twice;
        // summarize/count only its patched version, else spanRecords double-counts and the digest
        // sees the utterance twice. recs are file-order (ascending) so the later line wins.
        const rawRecs = dedupeLastWins(recs.filter((r) => r.source?.kind !== 'summary'));
        if (summarizeSpan && rawRecs.length) {
          let text: string;
          try { text = await summarizeSpan(rawRecs); }
          catch { keepLines.push(...recs.map((r) => JSON.stringify(r))); continue; /* keep this hour; retry */ }
          if (!text || /^\(/.test(text.trim())) { keepLines.push(...recs.map((r) => JSON.stringify(r))); continue; }
          const from = rawRecs[0]!.interval.from;
          const to = rawRecs[rawRecs.length - 1]!.interval.to;
          const rec: SnapshotRecord = {
            ts: from, tz: 'IST', dockId: dock,
            source: { id: 'span-summary', kind: 'summary', device: 'station', host: 'station' },
            model: { name: 'gemini-summarizer', endpoint: 'in-process' },
            interval: { from, to, durationMs: Math.max(0, Date.parse(to) - Date.parse(from)) },
            payload: { text, hour: bkt, spanRecords: rawRecs.length, compressedAt: new Date(nowMs).toISOString() },
          };
          try {
            appendFileSync(summaryFile(dock), JSON.stringify(rec) + '\n'); anyCompressed = true;
            // SECOND output of the one summarizer pass (§7c): extract durable facts from this same
            // hour into the memory store. Best-effort — a failure here must NOT keep the raw (the
            // digest already succeeded); facts are a bonus, the compression is the contract.
            if (onCompressedSpan) { try { await onCompressedSpan(rawRecs); } catch { /* facts best-effort */ } }
          }
          catch { keepLines.push(...recs.map((r) => JSON.stringify(r))); /* couldn't persist → keep raw */ }
        } else if (!summarizeSpan) {
          anyCompressed = true; // no summarizer wired (tests): drop the aged hour without a digest
        }
        // else: bucket had only summary-kind records (shouldn't happen in a day-file) — drop.
      }
      if (!anyCompressed && keepLines.length === lines.length) continue; // nothing actually changed
      // rewrite the raw file with only the kept records (still-open hour + in-window + any retried)
      try {
        if (keepLines.length) writeFileSync(path, keepLines.join('\n') + '\n');
        else unlinkSync(path);
        changed = true;
      } catch { /* */ }
    }
    // trim the compressed tail on its own (much longer) horizon
    const sf = summaryFile(dock);
    if (existsSync(sf)) {
      try {
        const kept = readFileSync(sf, 'utf8').split('\n').filter((l) => {
          if (!l.trim()) return false;
          try { return (JSON.parse(l) as SnapshotRecord).interval.from >= summaryCutoffIso; } catch { return false; }
        });
        writeFileSync(sf, kept.length ? kept.join('\n') + '\n' : '');
      } catch { /* */ }
    }
    if (changed) touched.push(dock);
  }
  return touched;
}

export const retentionPaths = { ROOT, dockDir, dayFile, summaryFile };
export const retentionConfig = { RETAIN_MS, SUMMARY_RETAIN_MS, ENABLED };
