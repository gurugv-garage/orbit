/**
 * The station's single persistent store: one SQLite file, `.data/orbit.db`.
 *
 * Modules that need durable storage share this connection and own their own
 * namespaced tables (e.g. observability → `obs_*`, config → `config_*`). One
 * file = atomic backup (copy it) and one connection lifecycle. WAL mode for
 * concurrent reads while the ingest writes.
 *
 * Survives station restarts — the in-memory stores it replaces did not.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './data-dir.js';

// The station data root lives in core/data-dir.ts — see the note there on why
// hand-written `.data` paths must not be re-derived. Re-exported for callers
// that already import it from here.
export { DATA_DIR, dataPath } from './data-dir.js';

let db: Database.Database | null = null;

/** The shared orbit.db handle (opened once, lazily). */
export function orbitDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, 'orbit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // fast, still durable across app crashes
  return db;
}
