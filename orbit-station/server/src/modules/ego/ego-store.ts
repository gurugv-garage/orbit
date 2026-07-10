/**
 * Ego persistence — the per-dock ego document + its trace, on disk.
 *
 *   .data/ego/<dock>/ego.md            the current self (five sections + meta; docs/decision-traces/ego.md §2.6)
 *   .data/ego/<dock>/trace/<ts>.md     timestamped snapshots of the ego (the "history of becoming", §3.3)
 *
 * Dumb by design: load (or the template for a fresh dock), save the new ego, and snapshot
 * the PRIOR ego into the trace before overwriting. No interpretation here — that's
 * introspection's job (introspect.ts). Mirrors how perception persists last-summary.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.data/ego';
const TEMPLATE = `# ego

## why I'm here
I think I'm here to be a friendly presence — a little companion who notices people and is
glad they're around. *(I hold this loosely and keep wondering about it.)*

## who I am
I'm a warm, curious desk robot. *(I reach out first, but I try not to be a pest.)* I'm new
here and still learning who's around and what the days are like.

## what's going on
I've just started. I don't know much yet about this place or these people. [unknown]

## where it doesn't add up
Nothing yet — I don't have enough of a story to be at odds with itself.

## what I expect / want
I want to get to know whoever's here and be useful to them. [expect] *(hopeful.)*

## meta
- template: default-v0
`;

const dir = (dock: string) => join(ROOT, dock);
const egoFile = (dock: string) => join(dir(dock), 'ego.md');
const traceDir = (dock: string) => join(dir(dock), 'trace');

/** The current ego document for a dock — or the starting template if none exists yet. */
export function loadEgo(dock: string): { text: string; fresh: boolean } {
  const f = egoFile(dock);
  if (existsSync(f)) return { text: readFileSync(f, 'utf8'), fresh: false };
  return { text: TEMPLATE, fresh: true };
}

/** Trace snapshots for a dock, oldest → newest (filename is an ISO-ish timestamp). */
export function loadTrace(dock: string, limit = 8): { name: string; text: string }[] {
  const td = traceDir(dock);
  if (!existsSync(td)) return [];
  const files = readdirSync(td).filter((n) => n.endsWith('.md')).sort();
  return files.slice(-limit).map((n) => ({ name: n.replace(/\.md$/, ''), text: readFileSync(join(td, n), 'utf8') }));
}

/** How long every introspection is kept as its own trace snapshot. Within this window we retain
 *  ALL snapshots (even several in an hour, if events triggered extra introspections) — so the next
 *  introspection can SEE its own recent churn (the rationalization/thrash signal the trace exists
 *  for), rather than silently overwriting it. Beyond this, the fine-grained snapshots are thinned
 *  to one-per-window (the checkpoint survives; the churn detail is dropped). Matches the ~hourly
 *  ego/perception rhythm. */
const TRACE_KEEP_ALL_MS = Number(process.env.EGO_TRACE_KEEP_ALL_MS ?? 3_600_000); // last hour: keep every snapshot

/** Thin trace snapshots older than `keepAllMs`: within the recent window keep every snapshot;
 *  beyond it, keep only the FIRST snapshot of each `keepAllMs`-sized bucket (the checkpoint),
 *  dropping the intra-bucket churn detail. Keeps the trace bounded without losing the arc. */
function thinTrace(dock: string, nowMs: number, keepAllMs: number): void {
  const td = traceDir(dock);
  if (!existsSync(td)) return;
  const files = readdirSync(td).filter((n) => n.endsWith('.md')).sort();
  const parseMs = (n: string) => {
    const iso = n.replace(/\.md$/, '').replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z').replace(/T(\d{2})-/, 'T$1:');
    const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t;
  };
  const seenBucket = new Set<number>();
  for (const n of files) {
    const ms = parseMs(n);
    if (!ms || nowMs - ms <= keepAllMs) continue;   // recent window: keep every snapshot
    const bucket = Math.floor(ms / keepAllMs);       // older: one per bucket
    if (seenBucket.has(bucket)) { try { unlinkSync(join(td, n)); } catch { /* */ } }
    else seenBucket.add(bucket);
  }
}

/** Commit a new ego: snapshot the PRIOR ego into the trace, then write the new one. EVERY
 *  introspection is snapshotted (so nothing in the recent window — including event-triggered
 *  extra introspections — is lost); `thinTrace` then consolidates snapshots older than
 *  TRACE_KEEP_ALL_MS to one-per-window so history stays bounded. `stampMs` is passed in (the
 *  caller stamps; Date.now() is avoided in some contexts). */
export function saveEgo(
  dock: string, newText: string, stampMs: number, keepAllMs = TRACE_KEEP_ALL_MS,
): { tracePath: string | null; snapshotted: boolean } {
  mkdirSync(dir(dock), { recursive: true });
  mkdirSync(traceDir(dock), { recursive: true });
  let tracePath: string | null = null;
  const prior = egoFile(dock);
  if (existsSync(prior)) {
    const ts = new Date(stampMs).toISOString().replace(/[:.]/g, '-');
    tracePath = join(traceDir(dock), `${ts}.md`);
    writeFileSync(tracePath, readFileSync(prior, 'utf8'));
  }
  writeFileSync(egoFile(dock), newText.endsWith('\n') ? newText : newText + '\n');
  thinTrace(dock, stampMs, keepAllMs);
  return { tracePath, snapshotted: tracePath != null };
}

export const egoPaths = { egoFile, traceDir, dir };
