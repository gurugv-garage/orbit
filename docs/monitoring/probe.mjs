#!/usr/bin/env node
/**
 * Monitoring probes — the follow-up questions a run asks when a number looks off.
 *
 * collect.mjs answers "what are the numbers"; this answers "is that number real".
 * Each probe pulls the EVIDENCE behind a metric (transcripts, clips, timings) so a
 * tripped threshold becomes a finding with proof instead of a theory.
 *
 *   node docs/monitoring/probe.mjs <probe> [--hours 24] [--dock dock-redmi]
 *
 *   suppressed-barges  did self-motion-suppressed onsets have real speech behind
 *                      them? (each one is an interruption that never paused the reply)
 *   dropped-speech     re-transcribe kept dropped clips: how many carried words?
 *                      needs the STT sidecar on :8078. Slow (one call per clip).
 *   endpoint-lag       do utterances overlapping TTS endpoint DURING the reply,
 *                      or only after it ends? (the barge-endpointing regression)
 *   tts-delay          LLM-end → speech-start, split by reply length
 *   followup-chains    runs of consecutive followup/busy-drain turns (the dock
 *                      talking to room noise)
 *
 * These are DIAGNOSTIC, not exhaustive — when a run sees something these probes
 * don't cover, write a new query, and add it here if it earns a second use.
 */

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STATION = arg('station', process.env.ORBIT_STATION ?? 'http://localhost:8099');
const DOCK = arg('dock', 'dock-redmi');
const HOURS = Number(arg('hours', '24'));
const to = Number(arg('to', String(Date.now())));
const from = to - HOURS * 3600_000;
const probe = process.argv[2];

const api = async (p) => (await fetch(`${STATION}/api/observability${p}`)).json();
const evs = async () => (await api(`/conv-events?dock=${DOCK}&from=${from}&to=${to}&limit=50000`)).events ?? [];
const turns = async () => (await api(`/incident?dock=${DOCK}&from=${from}&to=${to}`)).turns ?? [];
const clock = (ms) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 19);
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

const probes = {
  // An onset the self-motion guard suppressed, with a transcript right after, is an
  // interruption that never paused the reply — the user talked and was talked over.
  async 'suppressed-barges'() {
    const e = await evs();
    const skips = e.filter((x) => x.verdict === 'barge:skip:self-motion');
    const finals = e.filter((x) => x.type === 'stt:final' && x.audioStartAt);
    let withWords = 0;
    for (const s of skips) {
      const near = finals.find((f) => Math.abs(f.audioStartAt - s.ts) < 8000);
      if (near) { withWords++; console.log(`  ${clock(s.ts)} suppressed → "${(near.text ?? '').slice(0, 60)}"`); }
    }
    console.log(`\nskips: ${skips.length} | holds: ${e.filter((x) => x.verdict === 'barge:hold').length}`);
    console.log(`skips WITH speech within 8s: ${withWords}/${skips.length} (${Math.round((100 * withWords) / Math.max(skips.length, 1))}%)`);
  },

  // The kept clips are the only falsifiable evidence about the voiced-fraction gate.
  async 'dropped-speech'() {
    const drops = (await evs()).filter((x) => x.type === 'stt:drop' && x.verdict === 'voiced-fraction' && x.audioStartAt);
    console.log(`transcribing ${drops.length} dropped clips (sidecar :8078)…`);
    let words = 0, gone = 0;
    for (const d of drops) {
      const r = await fetch(`${STATION}/api/perception/utterance-audio/${DOCK}/${d.audioStartAt}`);
      if (!r.ok) { gone++; continue; }
      const wav = Buffer.from(await r.arrayBuffer()).subarray(44); // strip WAV header
      const res = await fetch('http://127.0.0.1:8078/transcribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pcm_b64: wav.toString('base64'), sample_rate: 16000 }),
      }).then((x) => x.json()).catch(() => ({}));
      const t = (res.text ?? '').trim();
      if (t.replace(/[^a-z0-9]/gi, '').length >= 2) {
        words++;
        console.log(`  ${clock(d.audioStartAt)} ${d.detail?.voicedPct}% voiced speaking=${d.detail?.speaking} → "${t.slice(0, 60)}"`);
      }
    }
    console.log(`\nreal words in ${words}/${drops.length - gone} transcribable drops (${Math.round((100 * words) / Math.max(drops.length - gone, 1))}%); ${gone} clips evicted`);
  },

  // Utterances that overlap the dock's TTS should endpoint DURING the reply; if they
  // only close after tts-end, the barge hold has nothing to decide on in time.
  async 'endpoint-lag'() {
    const e = await evs();
    const wins = [];
    const starts = e.filter((x) => x.verdict === 'tts-start').map((x) => x.ts);
    const ends = e.filter((x) => x.verdict === 'tts-end').map((x) => x.ts);
    for (const s of starts) { const en = ends.find((x) => x > s); if (en) wins.push([s, en]); }
    const rows = [];
    for (const x of e) {
      if (!x.audioStartAt || !x.audioEndAt) continue;
      const w = wins.find(([s, en]) => s <= x.audioStartAt && x.audioStartAt <= en);
      if (w) rows.push({ tail: (x.audioEndAt - w[1]) / 1000, dur: (x.audioEndAt - x.audioStartAt) / 1000, type: x.type });
    }
    const during = rows.filter((r) => r.tail < 0).length;
    console.log(`TTS windows: ${wins.length} | utterances starting inside one: ${rows.length}`);
    console.log(`endpointed DURING the reply: ${during}/${rows.length} (${Math.round((100 * during) / Math.max(rows.length, 1))}%)`);
    console.log(`median duration ${med(rows.map((r) => r.dur))}s (baseline: 2.6s in silence)`);
  },

  // The mechanical gap the user feels between "model finished" and "dock speaks".
  async 'tts-delay'() {
    const ts = await turns();
    const rows = [];
    for (const t of ts) {
      const st = t.steps ?? [], sp = t.speech ?? [];
      if (st.length !== 1 || !sp.length || !st[0].endedAt) continue;
      const gap = sp[0].startedAt - st[0].endedAt;
      if (gap > -3000 && gap < 15000) rows.push({ gap, len: (st[0].text ?? '').length });
    }
    const short = rows.filter((r) => r.len < 50).map((r) => r.gap);
    const long = rows.filter((r) => r.len >= 150).map((r) => r.gap);
    console.log(`n=${rows.length} single-step spoken turns`);
    console.log(`gap p50 ${med(rows.map((r) => r.gap))}ms | short replies ${med(short)}ms | long replies ${med(long)}ms`);
  },

  // A chain = the dock replying to its own followup window repeatedly, i.e. talking
  // to room noise. Long chains are the 82-turn meeting-chatter shape.
  async 'followup-chains'() {
    const ts = (await turns()).sort((a, b) => a.startedAt - b.startedAt);
    let run = [], best = [];
    for (const t of ts) {
      const v = t.trigger?.via ?? '';
      if (v === 'followup-window' || v === 'busy-drain') run.push(t);
      else { if (run.length > best.length) best = run; run = []; }
    }
    if (run.length > best.length) best = run;
    console.log(`longest consecutive followup/busy-drain chain: ${best.length} turns`);
    for (const t of best.slice(0, 8)) console.log(`  ${clock(t.startedAt)} "${(t.trigger?.text ?? '').slice(0, 60)}"`);
  },
};

if (!probes[probe]) {
  console.error(`unknown probe "${probe ?? ''}". available: ${Object.keys(probes).join(', ')}`);
  process.exit(1);
}
await probes[probe]();
