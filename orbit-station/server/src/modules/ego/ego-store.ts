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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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

/** Newest trace snapshot's mtime (ms), or 0 if none. */
function lastSnapshotMs(dock: string): number {
  const snaps = loadTrace(dock, 1);
  if (!snaps.length) return 0;
  // filename is an ISO-ish timestamp with ':'/'.' → '-'; parse it back
  const iso = snaps[0]!.name.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z').replace(/T(\d{2})-/, 'T$1:');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Commit a new ego: write it, and — only if the last trace snapshot is older than
 *  `traceGapMs` — first snapshot the PRIOR ego into the trace.
 *
 *  The gap is the "recently done → just override" rule (product design): every
 *  introspection updates ego.md, but button-mashing within the cooldown overrides in place
 *  instead of spamming the history. The trace records checkpoints, not every save.
 *  `stampMs` is passed in (the caller stamps; Date.now() is avoided in some contexts). */
export function saveEgo(
  dock: string, newText: string, stampMs: number, traceGapMs = 600_000,
): { tracePath: string | null; snapshotted: boolean } {
  mkdirSync(dir(dock), { recursive: true });
  mkdirSync(traceDir(dock), { recursive: true });
  let tracePath: string | null = null;
  const prior = egoFile(dock);
  const priorExists = existsSync(prior);
  const dueForSnapshot = stampMs - lastSnapshotMs(dock) >= traceGapMs;
  if (priorExists && dueForSnapshot) {
    const ts = new Date(stampMs).toISOString().replace(/[:.]/g, '-');
    tracePath = join(traceDir(dock), `${ts}.md`);
    writeFileSync(tracePath, readFileSync(prior, 'utf8'));
  }
  writeFileSync(egoFile(dock), newText.endsWith('\n') ? newText : newText + '\n');
  return { tracePath, snapshotted: tracePath != null };
}

export const egoPaths = { egoFile, traceDir, dir };
