import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSupersededSpeech } from './index.js';
import type { SnapshotRecord } from './snapshots.js';

// MEMORY-ARM DEDUP: parakeet writes a live-only speech record per utterance; the audio enricher
// writes the authoritative one for the same span. The memory arm must summarize the enricher's,
// not both — dropSupersededSpeech drops a liveOnly speech record when an enriched record overlaps.
function speech(from: string, to: string, text: string, flags: Partial<SnapshotRecord['payload']> = {}): SnapshotRecord {
  // A one-per-call ENRICHED record is kind:'enriched' with the hasSpeech roll-up + a speech segment;
  // a live parakeet record is kind:'speech'. dropSupersededSpeech keys on hasSpeech now.
  const enriched = (flags as { enriched?: boolean }).enriched === true;
  return {
    ts: from, tz: 'IST', dockId: 'd',
    source: { id: 's', kind: enriched ? 'enriched' : 'speech', device: 'x', host: 'station' },
    model: { name: 'm', endpoint: 'e' }, interval: { from, to, durationMs: 1000 },
    payload: { text, ...(enriched ? { hasSpeech: true, segments: [{ text, audioSource: 'speech' }] } : {}), ...flags },
  };
}
function vision(from: string, to: string): SnapshotRecord {
  return {
    ts: from, tz: 'IST', dockId: 'd', source: { id: 's', kind: 'vision', device: 'x', host: 'station' },
    model: { name: 'm', endpoint: 'e' }, interval: { from, to, durationMs: 1000 }, payload: { text: 'a scene' },
  };
}

test('drops a liveOnly parakeet record when an enriched record overlaps its span', () => {
  const recs = [
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:03', 'garbled um potassium', { liveOnly: true }),
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:03', 'How do we separate potassium salts?', { enriched: true }),
  ];
  const out = dropSupersededSpeech(recs);
  assert.equal(out.length, 1, 'the liveOnly parakeet record is dropped');
  assert.equal((out[0]!.payload as { enriched?: boolean }).enriched, true, 'the enriched record survives');
});

test('keeps a liveOnly record with NO overlapping enriched record (enricher not yet run)', () => {
  const recs = [
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:03', 'live text A', { liveOnly: true }),
    speech('2026-07-12T10:01:00', '2026-07-12T10:01:03', 'enriched elsewhere', { enriched: true }), // different span
  ];
  const out = dropSupersededSpeech(recs);
  assert.equal(out.length, 2, 'a live-only utterance the enricher has not covered still passes through');
});

test('no enriched records → everything passes (parakeet is still the truth until enrich lands)', () => {
  const recs = [
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:03', 'live A', { liveOnly: true }),
    speech('2026-07-12T10:00:05', '2026-07-12T10:00:08', 'live B', { liveOnly: true }),
  ];
  assert.equal(dropSupersededSpeech(recs).length, 2, 'no enricher output → nothing supersedes');
});

test('non-speech records are never dropped', () => {
  const recs = [
    vision('2026-07-12T10:00:00', '2026-07-12T10:00:03'),
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:03', 'garbled', { liveOnly: true }),
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:03', 'clean', { enriched: true }),
  ];
  const out = dropSupersededSpeech(recs);
  assert.equal(out.length, 2, 'vision + enriched survive; only the superseded liveOnly speech drops');
  assert.ok(out.some((r) => r.source.kind === 'vision'), 'vision kept');
});

test('partial overlap still supersedes (enricher window straddles the utterance)', () => {
  const recs = [
    speech('2026-07-12T10:00:02', '2026-07-12T10:00:05', 'live mid', { liveOnly: true }),
    speech('2026-07-12T10:00:00', '2026-07-12T10:00:10', 'enriched window', { enriched: true }), // straddles it
  ];
  assert.equal(dropSupersededSpeech(recs).length, 1, 'overlap (not just exact match) supersedes');
});
