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
  memoryGroundingSlice, type GroundingBelief,
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

// ── memoryGroundingSlice (the passive long-term-memory awareness block) ──────────

const b = (subject: string, claim: string, confidence: number): GroundingBelief => ({ subject, claim, confidence });

test('slice: filters below min confidence, sorts high→low, caps, hedge-tags', () => {
  const out = memoryGroundingSlice([
    b('guru', 'prefers tea', 0.9),
    b('guru', 'maybe likes jazz', 0.3),   // below 0.4 → dropped
    b('sam', 'works on firmware', 0.6),
  ], 0.4, 6);
  // kept high→low, dropped the 0.3
  assert.match(out, /What you already know/);
  assert.match(out, /belief, conf 0\.90/);
  assert.doesNotMatch(out, /jazz/);
  // order: 0.9 before 0.6
  assert.ok(out.indexOf('prefers tea') < out.indexOf('works on firmware'));
});

test('slice: caps to max', () => {
  const many = Array.from({ length: 10 }, (_, i) => b('x', `fact ${i}`, 0.9));
  const out = memoryGroundingSlice(many, 0.4, 3);
  assert.equal(out.split('\n').filter((l) => l.startsWith('•')).length, 3);
});

test('slice: empty when nothing clears the bar (grounding then omits the section)', () => {
  assert.equal(memoryGroundingSlice([b('x', 'low', 0.1)], 0.4, 6), '');
  assert.equal(memoryGroundingSlice([], 0.4, 6), '');
});

test('slice: a subjectless belief still renders (no "undefined:")', () => {
  const out = memoryGroundingSlice([b('', 'the kettle is broken', 0.7)], 0.4, 6);
  assert.match(out, /• the kettle is broken/);
  assert.doesNotMatch(out, /undefined/);
});

// ── coherent mode (coherence-layer.md step 1) ─────────────────────────────────
import { isSalient } from './grounding.js';

function srec(kind: string, from: string, payload: Record<string, unknown>): SnapshotRecord {
  return {
    ts: from, tz: 'IST', dockId: 'd1',
    source: { id: 's', kind: kind as SnapshotRecord['source']['kind'], device: 'x', host: 'y' },
    model: { name: 'm', endpoint: 'e' },
    interval: { from, to: from, durationMs: 0 },
    payload: { text: 't', ...payload },
  };
}

test('isSalient: keeps good speech, salient sound, changed vision, state streams', () => {
  assert.equal(isSalient(srec('speech', '2026-07-06T10:00:01.000+05:30', { confTier: 'good' })), true);
  assert.equal(isSalient(srec('speech', '2026-07-06T10:00:02.000+05:30', { confTier: 'shaky' })), false);
  assert.equal(isSalient(srec('speech', '2026-07-06T10:00:03.000+05:30', { confTier: 'garbage' })), false);
  assert.equal(isSalient(srec('sound', '2026-07-06T10:00:04.000+05:30', { salience: 'notable' })), true);
  assert.equal(isSalient(srec('sound', '2026-07-06T10:00:05.000+05:30', { salience: 'low' })), false);
  assert.equal(isSalient(srec('vision', '2026-07-06T10:00:06.000+05:30', { change: 'light turned on' })), true);
  assert.equal(isSalient(srec('vision', '2026-07-06T10:00:07.000+05:30', {})), false);
  assert.equal(isSalient(srec('identity', '2026-07-06T10:00:08.000+05:30', {})), true);
  assert.equal(isSalient(srec('bodymotion', '2026-07-06T10:00:09.000+05:30', {})), true);
});

test('coherent mode: tail keeps only salient records; head summary unchanged', () => {
  const last = { dockId: 'd1', text: 'A calm evening.', window: { from: '2026-07-06T10:00:00.000+05:30', to: '2026-07-06T10:01:00.000+05:30' }, computedAt: 1_000_000 };
  const recent = [
    srec('speech', '2026-07-06T10:01:10.000+05:30', { confTier: 'shaky', text: 'mush mush' }),
    srec('vision', '2026-07-06T10:01:20.000+05:30', { text: 'static room' }),
    srec('sound', '2026-07-06T10:01:30.000+05:30', { salience: 'startling', text: 'a loud crash', audioKind: 'impact' }),
  ];
  const coherent = buildGrounding({ last, recent, now: 1_060_000, nowIso: '2026-07-06T10:02:00.000+05:30', coherent: true })!;
  assert.ok(coherent.includes('a loud crash'), 'salient sound kept');
  assert.ok(!coherent.includes('mush mush'), 'garbage speech dropped');
  assert.ok(!coherent.includes('static room'), 'changeless vision dropped');
  assert.ok(coherent.includes('salient events since'), 'coherent tail label');
  const raw = buildGrounding({ last, recent, now: 1_060_000, nowIso: '2026-07-06T10:02:00.000+05:30' })!;
  assert.ok(raw.includes('mush mush'), 'raw mode keeps everything');
});

test('coherent mode: nothing salient since summary → summary alone (no noise tail)', () => {
  const last = { dockId: 'd1', text: 'A calm evening.', window: { from: '2026-07-06T10:00:00.000+05:30', to: '2026-07-06T10:01:00.000+05:30' }, computedAt: 1_000_000 };
  const recent = [srec('speech', '2026-07-06T10:01:10.000+05:30', { confTier: 'shaky', text: 'blur' })];
  const out = buildGrounding({ last, recent, now: 1_060_000, nowIso: '2026-07-06T10:02:00.000+05:30', coherent: true })!;
  assert.ok(out.includes('A calm evening'), 'summary head present');
  assert.ok(!out.includes('blur') && !out.includes('salient events'), 'no tail at all');
});
