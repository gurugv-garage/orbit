import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSnapshot, type SnapshotRecord } from './snapshots.js';
import { persistRecord, recordsSince, loadRecent, retentionPaths } from './retention.js';

// A unique dock name so the test writes into its OWN dir under the real record root and can
// clean up without touching any live dock's history. Fixed (no Date.now/random in this env).
const DOCK = 'test-reconcile-dock';
const dir = retentionPaths.dockDir(DOCK);

function speechRec(text: string, fromIso: string, patch: Record<string, unknown> = {}): SnapshotRecord {
  const from = new Date(fromIso);
  return makeSnapshot({
    dockId: DOCK,
    source: { id: 'app-x', kind: 'speech', device: 'dock-webrtc', host: 'station' },
    model: { name: 'parakeet-tdt', endpoint: 'local' },
    from, to: new Date(from.getTime() + 1000),
    payload: { text, lowConfidence: false, ...patch },
  });
}

function cleanup() { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }

// The enricher persist gap: a speech record lands (parakeet text), then the Gemini acoustic read
// re-appends the SAME record enriched (audioKind/summary/salience). The JSONL is append-only, so
// two lines exist for one utterance. Disk readers (the ego) must reconcile last-wins → see ONLY
// the enriched version, not the bare pre-patch one, and not both.
test('recordsSince reconciles a re-appended (enriched) record last-wins', () => {
  cleanup();
  try {
    const fromIso = '2026-07-12T14:41:26.435+05:30';
    const bare = speechRec('someone is talking', fromIso);
    persistRecord(bare);                                    // first write (durability)
    // enrich the SAME record (same interval.from + source.id + kind) and re-append
    const enriched = speechRec('someone is talking', fromIso, {
      audioKind: 'music', summary: 'upbeat music playing', salience: 'significant', bgModel: true,
    });
    persistRecord(enriched);                                // re-append (the enricher re-append)

    const seen = recordsSince(DOCK, '2026-07-12T00:00:00+05:30');
    const mine = seen.filter((r) => r.source.kind === 'speech');
    assert.equal(mine.length, 1, 'exactly one record for the utterance — the duplicate reconciled away');
    assert.equal((mine[0]!.payload as { audioKind?: string }).audioKind, 'music', 'the ENRICHED version won');
    assert.equal((mine[0]!.payload as { summary?: string }).summary, 'upbeat music playing');
  } finally { cleanup(); }
});

// loadRecent (boot-time ring restore) must reconcile the same way, else a restart re-hydrates the
// bare pre-patch line and loses the acoustic read.
test('loadRecent reconciles a re-appended record last-wins', () => {
  cleanup();
  try {
    const fromIso = new Date(Date.parse('2026-07-12T14:41:26.435+05:30')).toISOString();
    const bare = speechRec('a crash', fromIso);
    persistRecord(bare);
    const enriched = speechRec('a crash', fromIso, { audioKind: 'impact', salience: 'significant' });
    persistRecord(enriched);

    // load a wide window that certainly contains the record (anchor nowMs to the record time)
    const nowMs = Date.parse(fromIso) + 1000;
    const seen = loadRecent(DOCK, nowMs, 3600_000).filter((r) => r.source.kind === 'speech');
    assert.equal(seen.length, 1, 'one record after reconcile');
    assert.equal((seen[0]!.payload as { audioKind?: string }).audioKind, 'impact', 'enriched version won');
  } finally { cleanup(); }
});

// A record that is NEVER enriched must pass through untouched (no false dedup across distinct
// utterances that merely share a source).
test('distinct utterances from the same source are NOT collapsed', () => {
  cleanup();
  try {
    persistRecord(speechRec('one', '2026-07-12T14:41:26.000+05:30'));
    persistRecord(speechRec('two', '2026-07-12T14:41:40.000+05:30'));
    const seen = recordsSince(DOCK, '2026-07-12T00:00:00+05:30').filter((r) => r.source.kind === 'speech');
    assert.equal(seen.length, 2, 'two different start-times → two records');
    assert.deepEqual(seen.map((r) => (r.payload as { text: string }).text), ['one', 'two']);
  } finally { cleanup(); }
});
