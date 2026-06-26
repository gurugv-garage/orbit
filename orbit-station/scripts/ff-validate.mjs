#!/usr/bin/env node
/**
 * ff-validate — judge a faceFollow live-test run from its GROUND-TRUTH log.
 *
 * Reads a task.log that contains [ff-event] (transitions) + [ff-tick] (per-tick metrics),
 * emitted by the face-follow task under FF_MEASURE=1. Computes the metrics each use-case
 * flow needs (docs/operations/facefollow-live-test.md) and prints PASS/FAIL per flow, so a
 * live test is judged by numbers, not by eye.
 *
 *   node scripts/ff-validate.mjs <task.log> [--mode salient|named] [--name <target>]
 *
 * It is SEGMENT-AGNOSTIC: rather than require you to mark each flow, it derives the events
 * (acquire/lose/search/relock/yield/resume) + hold windows from the log and reports whether
 * the REQUIRED behaviours appeared at all, plus the quality numbers (hold duration, move
 * rate during holds, name-flip count, sweep span, named-substitution check). Read the
 * summary against the protocol table.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const mode = (args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'salient');
const target = args.includes('--name') ? args[args.indexOf('--name') + 1] : null;
if (!file) { console.error('usage: ff-validate.mjs <task.log> [--mode salient|named] [--name X]'); process.exit(2); }

const lines = readFileSync(file, 'utf8').split('\n');

// ── parse ───────────────────────────────────────────────────────────────────
const events = []; // {ts, kind, from, to, lockName}
const ticks = [];  // {ts, n, mode, nf, lockName, ex, ey, foot, neck, hasCmd}
const numAfter = (s, key) => { const m = s.match(new RegExp(`${key}=(-?[0-9.]+)`)); return m ? Number(m[1]) : null; };
for (const ln of lines) {
  if (ln.includes('[ff-event]')) {
    const ts = numAfter(ln, 'ts');
    const kind = (ln.match(/\] ts=\d+ (\w[\w-]*)/) || [])[1];
    const lk = (ln.match(/lock=([^\s]+)/) || [])[1];
    const lockName = lk && lk !== '-' ? lk.split('@')[0] : null;
    events.push({ ts, kind, lockName: lockName === '?' ? null : lockName });
  } else if (ln.includes('[ff-tick]')) {
    const ts = numAfter(ln, 'ts');
    const tmode = (ln.match(/mode=(\w+)/) || [])[1];
    const nf = numAfter(ln, 'nf');
    const lk = (ln.match(/lock=([^\s]+)/) || [])[1];
    const lockName = lk && lk !== '-' ? lk.split('@')[0] : null;
    const err = (ln.match(/err=\(([^)]*)\)/) || [])[1] || '';
    const [exs, eys] = err.split(',');
    const ex = exs && exs !== '-' ? Number(exs) : null;
    const ey = eys && eys !== '-' ? Number(eys) : null;
    // pose=foot<NN>/neck<NN> — parse ONLY the pose token (cmd= also contains foot/neck).
    const poseM = ln.match(/pose=foot(-?\d+)\/neck(-?\d+)/);
    const foot = poseM ? Number(poseM[1]) : null;
    const neck = poseM ? Number(poseM[2]) : null;
    const hasCmd = /cmd=foot/.test(ln);
    ticks.push({ ts, mode: tmode, nf, lockName: lockName === '?' ? null : lockName, ex, ey, foot, neck, hasCmd });
  }
}
if (!ticks.length) { console.error('no [ff-tick] lines — was FF_MEASURE=1 set?'); process.exit(2); }

// ── derive ──────────────────────────────────────────────────────────────────
const kinds = (k) => events.filter((e) => e.kind === k);
const span = (ticks.at(-1).ts - ticks[0].ts) / 1000;

// hold windows: contiguous runs of mode=track on the SAME lock name (or unnamed).
const holds = [];
let cur = null;
for (const t of ticks) {
  const inTrack = t.mode === 'track' && t.lockName !== undefined;
  if (inTrack && cur && t.lockName === cur.lockName) {
    cur.endTs = t.ts; cur.ticks++; if (t.hasCmd) cur.moves++;
  } else {
    if (cur) holds.push(cur);
    cur = inTrack ? { lockName: t.lockName, startTs: t.ts, endTs: t.ts, ticks: 1, moves: t.hasCmd ? 1 : 0 } : null;
  }
}
if (cur) holds.push(cur);
const longestHold = holds.reduce((m, h) => Math.max(m, (h.endTs - h.startTs) / 1000), 0);
const longestHoldObj = holds.sort((a, b) => (b.endTs - b.startTs) - (a.endTs - a.startTs))[0];

// sweep span: foot range during search ticks.
const searchFeet = ticks.filter((t) => t.mode === 'search' && t.foot != null).map((t) => t.foot);
const sweepSpan = searchFeet.length ? Math.max(...searchFeet) - Math.min(...searchFeet) : 0;

// name flips during the longest hold (should be ~0 for a stable hold).
const nameFlips = Math.max(0, kinds('relock').length);
// named-substitution check: in named mode, did we EVER lock a name != target?
const lockedNames = [...new Set(ticks.filter((t) => t.lockName).map((t) => t.lockName))];
const substituted = mode === 'named' && target
  ? lockedNames.filter((n) => n.toLowerCase() !== target.toLowerCase())
  : [];

// track↔search bounce count (a healthy run has few; thrashing = many).
let bounces = 0;
for (let i = 1; i < ticks.length; i++) {
  const a = ticks[i - 1].mode, b = ticks[i].mode;
  if ((a === 'track' && b === 'search') || (a === 'search' && b === 'track')) bounces++;
}

// ── judge ───────────────────────────────────────────────────────────────────
// search ticks (mode=search) + how many DISTINCT track→...→track re-acquisitions happened.
const searchTicks = ticks.filter((t) => t.mode === 'search').length;
let reacqs = 0;            // transitions search→track (re-acquired after a search)
for (let i = 1; i < ticks.length; i++) if (ticks[i - 1].mode === 'search' && ticks[i].mode === 'track') reacqs++;

const pass = (b) => (b ? 'PASS' : 'FAIL');
const F = [];
F.push(['F1 acquire', kinds('acquire').length >= 1, `${kinds('acquire').length} acquire event(s)`]);
F.push(['F2/F8 hold', longestHold >= 15, `longest hold ${longestHold.toFixed(1)}s` + (longestHoldObj ? ` (${longestHoldObj.moves} moves over ${longestHoldObj.ticks} ticks)` : '')]);
// F5 lose→search: SALIENT drops the lock (lose event) then sweeps; NAMED keeps the target
// name while sweeping (no lose event — a named lock is never abandoned), so judge on "entered
// search + actually swept" for both, plus require the lose event ONLY in salient mode.
const swept = searchTicks >= 2 && sweepSpan >= 8;
F.push(['F5 lose→search', swept && (mode === 'named' || kinds('lose').length >= 1),
  `${kinds('lose').length} lose, ${searchTicks} search ticks, sweep span ${sweepSpan}°`]);
// F6 re-acquire: SALIENT may relock a DIFFERENT person; NAMED re-locks the SAME target. Both
// show as a search→track re-acquisition.
F.push(['F6 re-acquire', reacqs >= 1, `${reacqs} search→track re-acquisition(s), ${kinds('relock').length} relock`]);
F.push(['F7 forever-loop', span > 30 && ticks.length > 40, `ran ${span.toFixed(0)}s, ${ticks.length} ticks, no crash`]);
F.push(['stability (low bounce)', bounces <= Math.max(4, ticks.length * 0.1), `${bounces} track↔search bounces`]);
if (mode === 'named') {
  F.push(['N2/N3 no substitution', substituted.length === 0, substituted.length ? `LOCKED non-target: ${substituted.join(',')}` : `only locked target${target ? ` (${target})` : ''}`]);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nfaceFollow live-test report — ${file}`);
console.log(`mode=${mode}${target ? ` target=${target}` : ''}  duration=${span.toFixed(0)}s  ticks=${ticks.length}  events=${events.length}`);
console.log('events:', ['acquire', 'relock', 'lose', 'search', 'yield', 'resume'].map((k) => `${k}=${kinds(k).length}`).join('  '));
console.log('holds: ', holds.map((h) => `${h.lockName ?? '?'}:${((h.endTs - h.startTs) / 1000).toFixed(0)}s/${h.moves}mv`).join('  ') || '(none)');
console.log('');
let allGreen = true;
for (const [name, ok, detail] of F) { if (!ok) allGreen = false; console.log(`  [${pass(ok)}] ${name.padEnd(22)} — ${detail}`); }
console.log(`\n${allGreen ? '✅ ALL FLOWS GREEN' : '❌ SOME FLOWS FAILED'} — judge against docs/operations/facefollow-live-test.md\n`);
process.exit(allGreen ? 0 : 1);
