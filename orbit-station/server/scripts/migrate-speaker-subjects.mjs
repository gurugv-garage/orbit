#!/usr/bin/env node
/**
 * ONE-OFF migration (bg-audio-summarizer.md §7a.1): long-term memories subject-keyed to
 * a meaningless diarization label ("speaker 0", "speaker 1") — 81% of the store when
 * measured — get their `subject` cleared so recall stops surfacing a phantom person.
 * Claims are left as-is (reconcile revises stale claims over time); only the SUBJECT
 * axis (exact-match retrieval key) is corrected. Idempotent; prints a dry-run first.
 *
 * Usage (station may be running — sqlite WAL handles a writer):
 *   node scripts/migrate-speaker-subjects.mjs            # dry run (default)
 *   node scripts/migrate-speaker-subjects.mjs --apply    # perform the update
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// core/db.ts resolves DATA_DIR to orbit-station/.data (one level ABOVE server/).
const dbPath = process.env.ORBIT_DB ?? path.join(here, '..', '..', '.data', 'orbit.db');
const apply = process.argv.includes('--apply');

const db = new Database(dbPath);
const rows = db.prepare(
  "SELECT id, dock_id, subject, status, substr(claim, 1, 70) AS claim FROM memory WHERE subject GLOB 'speaker [0-9]*'",
).all();

console.log(`${dbPath}: ${rows.length} memories with a 'speaker N' subject`);
const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log('by status:', byStatus);
for (const r of rows.slice(0, 8)) console.log(`  [${r.status}] ${r.dock_id} subj="${r.subject}" ${r.claim}`);
if (rows.length > 8) console.log(`  … and ${rows.length - 8} more`);

if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to clear these subjects.');
  process.exit(0);
}
const res = db.prepare("UPDATE memory SET subject = '' WHERE subject GLOB 'speaker [0-9]*'").run();
console.log(`\nAPPLIED: cleared subject on ${res.changes} memories.`);
