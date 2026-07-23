#!/usr/bin/env node
/**
 * Monitoring collector — one run's raw numbers, from the STORED data only.
 *
 * Reads observability + conv_events + cost for a window and prints a JSON blob
 * that docs/monitoring/README.md turns into a scored report. Runs NO live tests
 * and drives no hardware: it is safe at any hour, and re-running it for a past
 * window reproduces that window's numbers exactly (modulo retention).
 *
 *   node docs/monitoring/collect.mjs [--hours 24] [--dock dock-redmi] [--station http://localhost:8099]
 *
 * Every metric here is one an LLM can compare against docs/monitoring/RESULTS.md
 * history; keep the OUTPUT SHAPE stable so old runs stay comparable, and add new
 * metrics as new keys rather than renaming existing ones.
 */

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const STATION = arg('station', process.env.ORBIT_STATION ?? 'http://localhost:8099');
const DOCK = arg('dock', 'dock-redmi');
const HOURS = Number(arg('hours', '24'));
const to = Number(arg('to', String(Date.now())));
const from = to - HOURS * 3600_000;

const api = async (path) => {
  const r = await fetch(`${STATION}/api/observability${path}`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
};
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
const count = (arr, fn) => arr.filter(fn).length;

const [events, incident, health, cost, costSeries] = await Promise.all([
  api(`/conv-events?dock=${DOCK}&from=${from}&to=${to}&limit=50000`).then((j) => j.events ?? []),
  api(`/incident?dock=${DOCK}&from=${from}&to=${to}`),
  api('/health?window=200'),
  api(`/cost/summary?from=${from}&to=${to}&groupBy=usecase`),
  api(`/cost/series?from=${to - 7 * 24 * 3600_000}&to=${to}&groupBy=kind`),
]);

const turns = incident.turns ?? [];
const verdict = (v) => count(events, (e) => e.verdict === v);
const typed = (t) => count(events, (e) => e.type === t);

// ── speech: what the dock heard, and what it threw away ─────────────────────
const drops = events.filter((e) => e.type === 'stt:drop');
const vfDrops = drops.filter((e) => e.verdict === 'voiced-fraction');
const finals = events.filter((e) => e.type === 'stt:final');
const sttLag = finals.map((e) => (e.sttFinalAt ?? 0) - (e.audioEndAt ?? 0)).filter((n) => n > 0);

// ── barge: did interruptions work? ──────────────────────────────────────────
const releases = events.filter((e) => String(e.verdict ?? '').startsWith('barge:release:'));
const bargeOutcome = (suffix) => count(releases, (e) => e.verdict.endsWith(suffix));

// ── turns: why they ran, why they stopped ───────────────────────────────────
const via = {};
for (const t of turns) { const v = t.trigger?.via ?? t.trigger?.kind ?? '?'; via[v] = (via[v] ?? 0) + 1; }
const stopped = {};
for (const t of turns) if (t.speechStopped) stopped[t.speechStopped] = (stopped[t.speechStopped] ?? 0) + 1;
const silent = count(turns, (t) => t.state === 'done' && t.steps?.length
  && !t.steps.some((s) => (s.text ?? '').trim().length));
const errored = count(turns, (t) => t.state === 'failed' || t.steps?.some((s) => s.stopReason === 'error'));
const cacheReads = turns.flatMap((t) => t.steps ?? []).map((s) => s.usage?.cacheRead ?? 0);
const inputToks = turns.flatMap((t) => t.steps ?? []).map((s) => s.usage?.inputTokens ?? 0);
const cachedTotal = cacheReads.reduce((a, b) => a + b, 0);
const inputTotal = inputToks.reduce((a, b) => a + b, 0);

const out = {
  window: { dock: DOCK, from, to, hours: HOURS, generatedAt: Date.now() },
  volume: {
    turns: turns.length,
    utterancesHeard: finals.length,
    sessions: new Set(turns.map((t) => t.sessionId)).size,
  },
  hearing: {
    dropsTotal: drops.length,
    dropsVoicedFraction: vfDrops.length,
    dropsMinUtterance: count(drops, (e) => e.verdict === 'min-utterance'),
    withheld: typed('stt:withheld'),
    empty: typed('stt:empty'),
    unreachable: typed('stt:unreachable'),
    decodeFail: typed('audio:decode-fail'),
    // the barge-risk band: dropped while the dock was speaking
    dropsWhileSpeaking: count(vfDrops, (e) => e.detail?.speaking === true),
    sttLagMsP50: pct(sttLag, 50),
    sttLagMsP90: pct(sttLag, 90),
  },
  admission: {
    ranTurn: verdict('RAN-TURN'),
    skipNotAddressed: verdict('skip:not-addressed'),
    skipGarbage: verdict('skip:garbage'),
    queueBusy: verdict('queue:busy'),
    drainRan: verdict('drain:ran'),
    skipStale: verdict('skip:stale'),
    wake: verdict('wake') + verdict('wake+command'),
    via,
  },
  barge: {
    onsets: typed('vad:onset'),
    holds: verdict('barge:hold'),
    skipSelfMotion: verdict('barge:skip:self-motion'),
    resumedWithWords: bargeOutcome('queue:busy'),
    resumedNoWords: bargeOutcome('timeout:no-words'),
    yielded: count(releases, (e) => e.verdict === 'barge:release:timeout'),
    cancelledByStop: count(releases, (e) => e.verdict.includes('stop:')),
    stopDismiss: verdict('stop:dismiss'),
    stopPause: verdict('stop:pause'),
  },
  turnQuality: {
    silentTurns: silent,
    erroredTurns: errored,
    stoppedReasons: stopped,
    ttftMsP50: health.firstTokenMs?.p50 ?? null,
    ttftMsP90: health.firstTokenMs?.p90 ?? null,
    firstSpeechMsP50: health.firstSpeechMs?.p50 ?? null,
    firstSpeechMsP90: health.firstSpeechMs?.p90 ?? null,
    unfinishedTurns: health.unfinishedTurns ?? null,
    toolErrors: health.toolErrors ?? null,
  },
  cost: {
    totalUsd: Number((cost.total?.cost ?? 0).toFixed(4)),
    calls: cost.total?.calls ?? 0,
    inputTokens: cost.total?.inputTokens ?? 0,
    usdPerTurn: turns.length ? Number(((cost.total?.cost ?? 0) / turns.length).toFixed(4)) : null,
    byUsecase: Object.fromEntries((cost.groups ?? []).map((g) => [g.group, Number(g.cost.toFixed(4))])),
    cachePct: inputTotal ? Math.round((100 * cachedTotal) / (cachedTotal + inputTotal)) : 0,
    last7Days: costSeries.map((d) => ({ day: d.day, usd: Number(Object.values(d.byGroup ?? {}).reduce((a, b) => a + b, 0).toFixed(4)) })),
  },
};

console.log(JSON.stringify(out, null, 2));
