#!/usr/bin/env node
/**
 * Voice-fingerprint trial analysis: how much did the voice labels capture?
 * Reads a day's perception records and reports coverage + per-name score stats.
 *
 *   node scripts/voice-analyze.mjs [dock] [YYYY-MM-DD]   (defaults: dock-redmi, today)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dock = process.argv[2] ?? 'dock-redmi';
const day = process.argv[3] ?? new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
const file = fileURLToPath(new URL(`../server/.data/perception/records/${dock}/${day}.jsonl`, import.meta.url));

let rows;
try { rows = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)); }
catch { console.error(`no records at ${file}`); process.exit(1); }

// The jsonl is append-only with re-appends (last-wins) — dedup by identity, keep latest.
const byKey = new Map();
for (const r of rows) byKey.set(`${r.source?.kind}|${r.interval?.from}|${r.source?.id}`, r);
rows = [...byKey.values()];

const speech = rows.filter((r) => r.source?.kind === 'speech');
const withVoice = speech.filter((r) => r.payload?.voice);
const eligible = speech.filter((r) => (r.interval?.durationMs ?? 0) >= 800);

console.log(`${dock} ${day}: ${speech.length} speech finals, ${eligible.length} ≥0.8s, ${withVoice.length} voice-labeled`
  + (eligible.length ? ` (coverage ${(100 * withVoice.length / eligible.length).toFixed(0)}% of eligible)` : ''));

const byName = new Map();
for (const r of withVoice) {
  const v = r.payload.voice;
  // new records carry match:boolean (name = best candidate); old ones used name='unknown'
  const label = v.match === undefined ? v.name : (v.match ? v.name : `${v.name}? (near-miss)`);
  const b = byName.get(label) ?? [];
  b.push({ score: v.score, text: r.payload.text, ts: r.ts });
  byName.set(label, b);
}
for (const [name, xs] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
  const scores = xs.map((x) => x.score).filter((s) => s != null).sort((a, b) => a - b);
  const pct = (q) => scores.length ? scores[Math.floor(q * (scores.length - 1))].toFixed(2) : '—';
  console.log(`\n${name}: ${xs.length} utterances  score p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)}`);
  for (const x of xs.slice(-8)) {
    console.log(`  ${x.ts.slice(11, 19)} ${x.score != null ? x.score.toFixed(2) : ' —  '} "${(x.text ?? '').slice(0, 70)}"`);
  }
}
