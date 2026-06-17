/**
 * Perception grounding builder — the PURE per-turn context (3.1): last summary
 * (stamped with staleness) + the raw stream since it, else a recent raw window.
 * No Gemini, no network — `now`/`nowIso` injected, records built with makeSnapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot, isoIst, type SnapshotRecord, type SnapshotSource } from './snapshots.js';
import {
  buildGrounding, staleness, RAW_FALLBACK_MS, MAX_RAW_LINES, type LastSummary,
} from './grounding.js';

const DOCK = 'desk-1';
const NOW = Date.UTC(2026, 5, 16, 9, 0, 0); // fixed wall clock
const nowIso = isoIst(new Date(NOW));

/** A snapshot record `agoMs` before `now`, of a given kind, with text. */
function rec(kind: SnapshotSource['kind'], agoMs: number, text: string, dockId = DOCK): SnapshotRecord {
  const from = new Date(NOW - agoMs);
  return makeSnapshot({
    dockId,
    source: { id: 'cam-0', kind, device: 'dock-webrtc', host: 'station' },
    model: { name: 'test', endpoint: 'test' },
    from, to: from, payload: { text },
  });
}

function summaryAt(agoMs: number, text: string, windowFromAgo: number, windowToAgo: number): LastSummary {
  return {
    dockId: DOCK, text,
    window: { from: isoIst(new Date(NOW - windowFromAgo)), to: isoIst(new Date(NOW - windowToAgo)) },
    computedAt: NOW - agoMs,
  };
}

test('staleness phrasing across the ranges', () => {
  assert.equal(staleness(5_000), 'just now');
  assert.equal(staleness(45_000), '45s ago');
  assert.equal(staleness(120_000), '2 min ago');
  assert.equal(staleness(2 * 60 * 60_000), '2h ago');
});

test('summary + raw since: head carries staleness + window; tail is the since-stream', () => {
  const last = summaryAt(120_000, 'Guru is debugging and sounds frustrated.', 300_000, 120_000);
  // two records AFTER the summary window closed (120s ago), one BEFORE (should be excluded)
  const recent = [
    rec('speech', 200_000, 'old utterance inside the summary window'),
    rec('speech', 60_000, 'can you remind me to push at 5'),
    rec('vision', 30_000, 'person typing at a laptop'),
  ];
  const block = buildGrounding({ last, recent, now: NOW, nowIso })!;
  assert.match(block, /last summary \(2 min ago, covering /);
  assert.match(block, /Guru is debugging and sounds frustrated\./);
  assert.match(block, /Since then \(.*raw — not yet summarized\):/);
  assert.match(block, /remind me to push at 5/);
  assert.match(block, /person typing at a laptop/);
  // the record inside the summary window is NOT in the since-tail
  assert.doesNotMatch(block, /old utterance inside the summary window/);
});

test('summary but nothing since: head only, no "Since then"', () => {
  const last = summaryAt(10_000, 'Quiet room, no one present.', 90_000, 30_000);
  const recent = [rec('speech', 200_000, 'way before the summary')]; // all inside/older
  const block = buildGrounding({ last, recent, now: NOW, nowIso })!;
  assert.match(block, /last summary \(just now, covering /); // 10s old → "just now"
  assert.doesNotMatch(block, /Since then/);
});

test('no summary: recent raw window with its own header', () => {
  const recent = [
    rec('vision', 10_000, 'someone waves at the camera'),
    rec('speech', 5_000, 'hey orbit'),
  ];
  const block = buildGrounding({ last: null, recent, now: NOW, nowIso })!;
  assert.match(block, /recent \(.*raw — no summary yet\):/);
  assert.match(block, /someone waves at the camera/);
  assert.match(block, /hey orbit/);
});

test('no summary: records older than the fallback window are excluded', () => {
  const recent = [
    rec('speech', RAW_FALLBACK_MS + 30_000, 'too old to ground on'),
    rec('speech', 10_000, 'fresh enough'),
  ];
  const block = buildGrounding({ last: null, recent, now: NOW, nowIso })!;
  assert.match(block, /fresh enough/);
  assert.doesNotMatch(block, /too old to ground on/);
});

test('cold dock: no summary and no recent records → null (nothing injected)', () => {
  assert.equal(buildGrounding({ last: null, recent: [], now: NOW, nowIso }), null);
  // also null when records exist but are all past the fallback window
  const stale = [rec('speech', RAW_FALLBACK_MS + 60_000, 'ancient')];
  assert.equal(buildGrounding({ last: null, recent: stale, now: NOW, nowIso }), null);
});

test('the raw tail is capped at MAX_RAW_LINES (chatty window cannot blow up the prompt)', () => {
  const last = summaryAt(60_000, 'busy meeting', 600_000, 300_000);
  // many speech records after the window → exceed the cap
  const recent: SnapshotRecord[] = [];
  for (let i = 0; i < MAX_RAW_LINES + 20; i++) {
    recent.push(rec('speech', 200_000 - i * 1000, `line ${i}`));
  }
  const block = buildGrounding({ last, recent, now: NOW, nowIso })!;
  const sinceBody = block.split('Since then')[1] ?? '';
  const lineCount = sinceBody.split('\n').filter((l) => /SPEECH/.test(l)).length;
  assert.ok(lineCount <= MAX_RAW_LINES, `tail kept to <= ${MAX_RAW_LINES} (got ${lineCount})`);
  assert.match(block, /…/); // truncation marker present
});

test('grounding is dock-agnostic in the builder (caller filters); records pass through verbatim', () => {
  // the builder does NOT filter by dock — the facade does — so a record's text is
  // rendered regardless. (Guards against a future double-filter regression.)
  const recent = [rec('speech', 5_000, 'from this dock', 'other-dock')];
  const block = buildGrounding({ last: null, recent, now: NOW, nowIso })!;
  assert.match(block, /from this dock/);
});
