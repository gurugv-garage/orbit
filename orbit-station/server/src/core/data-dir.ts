/**
 * THE station data root — `orbit-station/.data/`.
 *
 * There is exactly ONE runtime data folder. Everything durable the station
 * writes (orbit.db, brain sessions, perception records, images, audio, feedback,
 * search shots, ego docs) lives under it.
 *
 * Why this file exists — two ways of naming that folder had drifted apart:
 *
 *   - source-relative: `new URL('../../../.data/', import.meta.url)`. The number
 *     of `../` depends on the importing file's DEPTH, so core/ (depth 2) and
 *     modules/x/ (depth 3) wrote the identical string and silently produced two
 *     different roots.
 *   - cwd-relative: a bare `'.data/brain'`, which resolves against
 *     process.cwd(). The station runs with cwd=server/, so those landed in
 *     server/.data — a THIRD folder.
 *
 * Both are now funnelled through `DATA_DIR` / `dataPath()` below, which resolve
 * once, from this file's own location, independent of cwd and of the caller's
 * depth. Never re-derive a `.data` path by hand; call `dataPath('brain', dock)`.
 *
 * (Kept separate from db.ts so that importing a path constant doesn't pull in
 * better-sqlite3 — tests and lightweight tools import this alone.)
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to `orbit-station/.data/` (core/ is 2 deep → 3 dots to root). */
export const DATA_DIR = fileURLToPath(new URL('../../../.data/', import.meta.url));

/** Join segments under the station data root: dataPath('brain', dock). */
export function dataPath(...segments: string[]): string {
  return join(DATA_DIR, ...segments);
}
