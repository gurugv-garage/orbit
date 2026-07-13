/**
 * midturn-harness — WI-0 of the busy-queue plan
 * (docs/findings/2026-07-13-busy-queue-black-hole.md, Addendum 3).
 *
 * Reproduces the RCA's mid-turn failure classes HEADLESS: no dock, no mic, no
 * speaker. Fakes the phone + body peers (like fake-phone.ts), drives turns via
 * the brain debug REST, injects speech heard WHILE BUSY via the new
 * `debug/hear` (no tap — a tap would interrupt), and judges from the same
 * ground truth the RCA used: the addressed-decision ring + the conversation
 * probe + the turn-status frames the fake phone receives.
 *
 * ⚠ BASELINE MODE: the assertions below encode the DOCUMENTED BROKEN behavior
 * of current main (the RCA's trial table). A green run means "the bugs
 * reproduce"; WI-1 flips these expectations to the fixed contract.
 *
 * Run (station up on :8099, LLM key in .env — a real model answers the turns):
 *
 *     npm run -w server smoke:midturn
 *
 * Scenarios (each self-contained, starts from idle):
 *   S4  control    — debug/hear lands in an open followup window → RAN-TURN
 *                    (proves the seam drives real turns; the B4 "working path")
 *   S1  black hole — hear during a RAN-TURN's thinking → queue:busy; bounce
 *                    re-trace at turn end; never answered; silently dropped
 *                    (no skip:stale trace) at the next drain >20s later (B2/B3)
 *   S2  ghost      — hear during an autonomous ('self') turn → queued, NO drain
 *                    at its end (the B1 ghost); the stale ghost then poisons a
 *                    fresh utterance queued with it (silent batch drop)
 *   S3  no stop    — "Stop. Never mind." during a turn → queue:busy, the turn
 *                    completes 'done', nothing cancels (D1)
 */

import { WebSocket } from 'ws';

const WS_URL = process.env.STATION_WS ?? 'ws://localhost:8099/ws';
const HTTP = process.env.STATION_HTTP ?? 'http://localhost:8099';
const DOCK = process.env.SMOKE_DOCK ?? 'smoke-midturn';
const BUSY_QUEUE_MAX_AGE_MS = 20_000; // mirrors modules/brain/index.ts (hard const there)

const t0 = Date.now();
const at = () => `+${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s`;
const log = (msg: string) => console.log(`${at()}  ${msg}`);

// ── fake peers (fake-phone.ts pattern) ──────────────────────────────────────

type Frame = { kind: string; payload: any; topic: string; at: number };
const frames: Frame[] = []; // everything the fake phone receives, in order

function connect(opts: {
  id: string; component: string; kind: string; caps: string[]; topics: string[];
  onEvent: (ws: WebSocket, kind: string, payload: any, topic: string) => void;
}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'hello', role: 'device', id: opts.id, dock: DOCK,
        component: opts.component, kind: opts.kind, caps: opts.caps,
        label: `${DOCK} ${opts.component} (midturn harness)`,
      }));
      ws.send(JSON.stringify({ t: 'subscribe', topics: opts.topics }));
      if (opts.topics.includes('agent')) {
        ws.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'hello', payload: {} }));
      }
      resolve(ws);
    });
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'event') opts.onEvent(ws, f.kind, f.payload, f.topic);
    });
    ws.on('error', reject);
  });
}

const pub = (ws: WebSocket, topic: string, kind: string, payload: unknown) =>
  ws.send(JSON.stringify({ t: 'publish', topic, kind, payload }));

// ── REST helpers (the brain debug surface) ──────────────────────────────────

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${HTTP}/api/brain/${encodeURIComponent(DOCK)}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
const say = (text: string) => post('/debug/say', { text });
const hear = (text: string) => post('/debug/hear', { text });
const think = (text: string) => post('/think', { text, kind: 'midturn-harness' });
const conv = async (): Promise<{ mode: string }> =>
  (await fetch(`${HTTP}/api/brain/${encodeURIComponent(DOCK)}/conversation`)).json() as any;
const ring = async (): Promise<Array<{ at: number; text: string; decision: string; mode: string }>> =>
  (await fetch(`${HTTP}/api/brain/${encodeURIComponent(DOCK)}/debug/addressed`)).json() as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitConv(want: string | string[], timeoutMs: number): Promise<string> {
  const wants = Array.isArray(want) ? want : [want];
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = (await conv()).mode;
    if (wants.includes(m)) return m;
    await sleep(150);
  }
  throw new Error(`conversation never reached ${wants.join('|')} within ${timeoutMs}ms (now: ${(await conv()).mode})`);
}

/** Wait for the NEXT terminal turn-status frame after `sinceIdx` in the frame log. */
async function waitTurnEnd(sinceIdx: number, timeoutMs: number): Promise<{ state: string; frameIdx: number }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (let i = sinceIdx; i < frames.length; i++) {
      const f = frames[i]!;
      if (f.kind === 'turn-status' && ['done', 'failed', 'cancelled'].includes(f.payload?.state)) {
        return { state: f.payload.state, frameIdx: i };
      }
    }
    await sleep(150);
  }
  throw new Error(`no terminal turn-status within ${timeoutMs}ms`);
}

const ringFor = async (text: string) => (await ring()).filter((e) => e.text?.includes(text));

// ── assertion bookkeeping ───────────────────────────────────────────────────

let pass = 0; let fail = 0;
function check(id: string, ok: boolean, detail: string): void {
  if (ok) { pass++; log(`  ✅ ${id}  ${detail}`); }
  else { fail++; log(`  ❌ ${id}  ${detail}`); }
}

// ── scenarios ───────────────────────────────────────────────────────────────

// Unique markers so ring text-matching can't collide across scenarios/turns —
// or across RUNS: the ring (last 50 decisions) survives on the station between
// harness invocations, so every marker carries a per-run nonce.
const RUN = Date.now().toString(36).slice(-4);
const B = `what color is grass, run ${RUN}`; // S1 mid-turn line
const G = `what day is it today, run ${RUN}`; // S2 ghost line
const F = `what color is the sky, run ${RUN}`; // S2 fresh line poisoned by the ghost
const STOP = `Stop. Never mind. Run ${RUN}.`;

async function idle(): Promise<void> {
  // followup expires after 8s; speaking is bounded; be generous.
  await waitConv('idle', 30_000);
  await sleep(1_700); // clear the autonomous settle gap (brainTaskSettleMs 1500)
}

async function s4_control(): Promise<void> {
  log('── S4 control: debug/hear in an open followup window runs a turn (B4 path)');
  await idle();
  const mark = frames.length;
  await say('Say the word hello and nothing else.');
  const a = await waitTurnEnd(mark, 60_000);
  check('S4a', a.state === 'done', `first turn terminal state = ${a.state}`);
  await waitConv('followup', 15_000); // phone TTS sim ran; window open
  const mark2 = frames.length;
  const goodbye = `And now say the word goodbye, run ${RUN}.`;
  await hear(goodbye);
  const entries = await ringFor(goodbye.slice(0, -1));
  check('S4b', entries.some((e) => e.decision === 'RAN-TURN'),
    `hear-in-followup decision(s): [${entries.map((e) => e.decision).join(', ')}] — expect RAN-TURN`);
  const b2 = await waitTurnEnd(mark2, 60_000);
  check('S4c', b2.state === 'done', `follow-up turn terminal state = ${b2.state}`);
}

async function s1_blackHole(): Promise<void> {
  log('── S1 black hole: mid-thinking speech queues, bounces, never answers, dies silently (B2/B3)');
  await idle();
  const mark = frames.length;
  await say('What is two plus two? Answer in one short sentence.');
  await waitConv('thinking', 20_000);
  await hear(`And ${B}?`);
  let e = await ringFor(B);
  check('S1a', e.length === 1 && e[0]!.decision === 'queue:busy',
    `inject during thinking → [${e.map((x) => x.decision).join(', ')}] — expect single queue:busy`);

  const end = await waitTurnEnd(mark, 60_000);
  const drainDeadline = Date.now(); // drain fires at turn end (the bug)
  await sleep(2_000); // let the drain re-entry land
  e = await ringFor(B);
  check('S1b', e.filter((x) => x.decision === 'queue:busy').length >= 2,
    `after turn ${end.state}: ${e.length} ring entries for the queued line ` +
    `[${e.map((x) => `${x.decision}@${x.mode}`).join(', ')}] — expect a 2nd queue:busy (the bounce, mode still thinking/speaking)`);
  check('S1c', !e.some((x) => x.decision === 'RAN-TURN'), 'queued line never ran a turn (the black hole)');

  // silent stale drop: next drain >20s after the bounce → batch deleted, NO trace
  log(`   waiting out the ${BUSY_QUEUE_MAX_AGE_MS / 1000}s staleness cap…`);
  await sleep(BUSY_QUEUE_MAX_AGE_MS + 1_500 - (Date.now() - drainDeadline));
  await idle();
  const countBefore = (await ringFor(B)).length;
  const mark2 = frames.length;
  await say('Say the single word test.');
  await waitTurnEnd(mark2, 60_000);
  await sleep(2_000);
  const after = await ringFor(B);
  check('S1d', after.length === countBefore && !after.some((x) => x.decision.includes('stale')),
    `after the next turn's drain: ring entries for the queued line ${countBefore}→${after.length}, ` +
    `no skip:stale — the batch died with NO trace (the silent drop)`);
}

async function s2_ghost(): Promise<void> {
  log('── S2 ghost: speech during an autonomous turn is never drained, then poisons a fresh line (B1→B2)');
  await idle();
  const mark = frames.length;
  await think('Say exactly: checking in. Then nothing else.');
  await waitConv('thinking', 20_000);
  await hear(`${G}?`);
  let e = await ringFor(G);
  check('S2a', e.length === 1 && e[0]!.decision === 'queue:busy',
    `inject during autonomous turn → [${e.map((x) => x.decision).join(', ')}]`);
  const ghostQueuedAt = Date.now();

  const end = await waitTurnEnd(mark, 60_000);
  await sleep(2_000);
  e = await ringFor(G);
  check('S2b', e.length === 1,
    `after autonomous turn ${end.state}: still ${e.length} ring entry — NO drain re-trace ` +
    `(contrast S1b: the autonomous lane has no drain at all — the ghost class)`);

  // the parked ghost goes stale, then poisons a FRESH utterance queued with it
  log(`   aging the ghost past the ${BUSY_QUEUE_MAX_AGE_MS / 1000}s cap…`);
  await sleep(Math.max(0, ghostQueuedAt + BUSY_QUEUE_MAX_AGE_MS + 1_500 - Date.now()));
  await idle();
  const mark2 = frames.length;
  await say('What is one plus one? Answer in one short sentence.');
  await waitConv('thinking', 20_000);
  await hear(`And ${F}?`);
  let f = await ringFor(F);
  check('S2c', f.length === 1 && f[0]!.decision === 'queue:busy', `fresh line queued with the ghost → [${f.map((x) => x.decision).join(', ')}]`);
  await waitTurnEnd(mark2, 60_000);
  await sleep(2_000);
  f = await ringFor(F);
  check('S2d', f.length === 1 && !f.some((x) => x.decision === 'RAN-TURN'),
    `after drain: fresh line entries = ${f.length}, ran = ${f.some((x) => x.decision === 'RAN-TURN')} — ` +
    `the 7s-old fresh line died silently because the ghost's firstAt poisoned the batch`);
}

async function s3_noStop(): Promise<void> {
  log('── S3 voice cannot stop a turn (D1)');
  await idle();
  const mark = frames.length;
  await say('Count from one to seven, slowly, one number per sentence.');
  await waitConv('thinking', 20_000);
  await hear(STOP);
  const e = await ringFor(STOP);
  check('S3a', e.length === 1 && e[0]!.decision === 'queue:busy',
    `"${STOP}" mid-turn → [${e.map((x) => x.decision).join(', ')}] — queued, not acted on`);
  const end = await waitTurnEnd(mark, 90_000);
  check('S3b', end.state === 'done',
    `turn terminal state = ${end.state} — completed as if nothing was said (voice-stop impossible)`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`midturn-harness → ${WS_URL} dock=${DOCK} (BASELINE mode: asserts the RCA's failures reproduce)`);

  // body peer: ack set_target so motion turns don't stall
  await connect({
    id: `${DOCK}-esp32`, component: 'body', kind: 'dock-body-fw', caps: ['servo'],
    topics: ['bodylink'],
    onEvent: (ws, kind, payload) => {
      if (kind === 'command') pub(ws, 'bodylink', 'applied', { parts: payload?.parts ?? {} });
    },
  });

  // phone peer: answers tool RPCs, records frames, simulates TTS playback
  // (speech-status true→false after each 'done') — the markers the conversation
  // state machine needs to leave 'thinking' the way the real phone does.
  await connect({
    id: `${DOCK}-phone`, component: 'phone', kind: 'dock-android-app',
    caps: ['voice', 'face', 'camera'],
    topics: ['agent', 'station', 'bodylink'],
    onEvent: (ws, kind, payload, topic) => {
      if (topic !== 'agent') return;
      frames.push({ kind, payload, topic, at: Date.now() });
      if (kind === 'tool-call') {
        pub(ws, 'agent', 'tool-result', {
          reqId: payload.reqId, toolCallId: payload.toolCallId, turnId: payload.turnId,
          content: `${payload.name} dispatched`, isError: false,
        });
      }
      if (kind === 'speak') log(`  [phone] speak: "${String(payload.text).slice(0, 60)}"`);
      if (kind === 'turn-status') {
        log(`  [phone] turn-status ${payload.state}`);
        if (payload.state === 'done') {
          // simulate TTS playback: 150ms to start, 1.2s of speech
          setTimeout(() => pub(ws, 'agent', 'speech-status', { turnId: payload.turnId, speaking: true }), 150);
          setTimeout(() => pub(ws, 'agent', 'speech-status', { turnId: payload.turnId, speaking: false }), 1_350);
        }
      }
    },
  });

  await sleep(500); // let presence/session settle

  const scenarios: Array<[string, () => Promise<void>]> = [
    ['S4', s4_control], ['S1', s1_blackHole], ['S2', s2_ghost], ['S3', s3_noStop],
  ];
  for (const [name, fn] of scenarios) {
    try { await fn(); }
    catch (err) { fail++; log(`  ❌ ${name}  scenario crashed: ${String(err)}`); }
  }

  console.log(`\n${fail === 0 ? 'PASS ✅' : 'FAIL ❌'}  ${pass} assertions passed, ${fail} failed ` +
    `(baseline mode: pass = the documented bugs reproduce)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('midturn-harness failed:', err); process.exit(1); });
