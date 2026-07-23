/**
 * Disk scanner — walks each inventory path and returns bytes + file count.
 *
 * Two things worth knowing:
 *
 *  1. It is deliberately a plain recursive walk (no `du` subprocess), so it
 *     behaves the same on macOS and Linux and reports APPARENT size (the sum of
 *     file sizes) rather than allocated blocks. `du -sh` will read slightly
 *     higher; that difference is block padding, not a bug.
 *
 *  2. Inventory entries NEST — `models` contains `models/perception-sidecar`,
 *     `server/data` contains `server/data/captures`. Each row reports its own
 *     full subtree size, but `ownBytes` subtracts any nested entry so the
 *     column can be summed into a total without double-counting.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { INVENTORY, REPO_ROOT, type StorageEntry } from './inventory.js';

export interface ScanRow extends StorageEntry {
  /** absolute resolved path (for copy-to-clipboard / manual rm) */
  abs: string;
  exists: boolean;
  /** total apparent bytes of the subtree */
  bytes: number;
  /** bytes excluding any nested inventory entry — safe to sum */
  ownBytes: number;
  files: number;
  /** epoch ms of the newest file in the subtree, 0 when empty */
  newest: number;
  /** ids of inventory entries contained within this one */
  contains: string[];
  /** set when the walk failed (permissions, vanished mid-scan) */
  error?: string;
}

export interface ScanResult {
  scannedAt: number;
  /** wall-clock cost of the scan, so the UI can warn before a re-run */
  durationMs: number;
  root: string;
  rows: ScanRow[];
  /** sum of ownBytes — the true on-disk footprint of everything inventoried */
  totalBytes: number;
}

interface Walked { bytes: number; files: number; newest: number }

/** Recursive apparent-size walk. Symlinks are counted as themselves, never
 *  followed — otherwise a link into node_modules could loop or double-count. */
async function walk(dir: string): Promise<Walked> {
  let bytes = 0;
  let files = 0;
  let newest = 0;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files, newest };
  }

  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      const sub = await walk(p);
      bytes += sub.bytes;
      files += sub.files;
      if (sub.newest > newest) newest = sub.newest;
    } else if (e.isFile()) {
      try {
        const st = await stat(p);
        bytes += st.size;
        files += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* vanished mid-walk — skip */
      }
    }
  }
  return { bytes, files, newest };
}

/** True when `child` is strictly inside `parent` (both absolute). */
function isInside(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child !== parent && child.startsWith(p);
}

/** Scan the whole inventory, or a subset by id. */
export async function scanStorage(only?: string[]): Promise<ScanResult> {
  const startedAt = Date.now();
  const picked = only?.length ? INVENTORY.filter((e) => only.includes(e.id)) : INVENTORY;

  const rows: ScanRow[] = await Promise.all(
    picked.map(async (e): Promise<ScanRow> => {
      const abs = resolve(REPO_ROOT, e.path);
      let st;
      try {
        st = await stat(abs);
      } catch {
        return { ...e, abs, exists: false, bytes: 0, ownBytes: 0, files: 0, newest: 0, contains: [] };
      }
      try {
        // An entry may point at a single file (e.g. orbit.db) as well as a dir.
        const w = st.isDirectory()
          ? await walk(abs)
          : { bytes: st.size, files: 1, newest: st.mtimeMs };
        return { ...e, abs, exists: true, bytes: w.bytes, ownBytes: w.bytes, files: w.files, newest: w.newest, contains: [] };
      } catch (err) {
        return {
          ...e, abs, exists: true, bytes: 0, ownBytes: 0, files: 0, newest: 0, contains: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Nesting pass: attribute each row's bytes to the DEEPEST enclosing row only,
  // so ownBytes across all rows sums to the real footprint.
  for (const parent of rows) {
    for (const child of rows) {
      if (!isInside(child.abs, parent.abs)) continue;
      // only subtract when `parent` is the child's nearest inventoried ancestor
      const nearer = rows.some((mid) => isInside(child.abs, mid.abs) && isInside(mid.abs, parent.abs));
      if (nearer) continue;
      parent.contains.push(child.id);
      parent.ownBytes -= child.bytes;
    }
    if (parent.ownBytes < 0) parent.ownBytes = 0;
  }

  return {
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    root: REPO_ROOT,
    rows,
    totalBytes: rows.reduce((n, r) => n + r.ownBytes, 0),
  };
}
