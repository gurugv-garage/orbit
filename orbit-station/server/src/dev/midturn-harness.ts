/**
 * midturn-harness — WI-0/WI-1 of the busy-queue plan
 * (docs/findings/2026-07-13-busy-queue-black-hole.md, Addendum 3).
 *
 * Exercises the mid-turn speech path HEADLESS: no dock, no mic, no speaker.
 * Fakes the phone + body peers (like fake-phone.ts), drives turns via the
 * brain debug REST, injects speech heard WHILE BUSY via `debug/hear` (no tap —
 * a tap would interrupt), and judges from the same ground truth the RCA used:
 * the addressed-decision ring + the conversation probe + turn-status frames.
 *
 * ✅ FIXED-CONTRACT mode (WI-1): asserts the busy-queue REWORK's contract —
 * every utterance heard while busy either RUNS in a combined turn at the next
 * settle (`drain:ran`) or is visibly traced `skip:stale`; zero silent
 * outcomes; every turn kind drains. The BASELINE version of this harness
 * (asserting the pre-fix black hole reproduced) is commit 30fb164.
 *
 * Run (station up on :8099, LLM key in .env — a real model answers the turns):
 *
 *     npm run -w server smoke:midturn
 *
 * Scenarios (each self-contained, starts from idle):
 *   S4  control    — debug/hear in an open followup window → RAN-TURN
 *   F1  core drain — two lines heard during thinking → ONE combined turn at
 *                    settle, both traced drain:ran (was: the black hole)
 *   F2  mixed age  — a >20s-old item traced skip:stale while a fresh item
 *                    queued with it still runs (was: ghost poisons the batch)
 *   F3  every kind — speech during an autonomous ('self') turn drains at ITS
 *                    settle (was: the ghost class — no drain outside RAN-TURN)
 *   F4  stop       — "Stop…" mid-turn still queues + gets answered at settle;
 *                    the turn completes (WI-2 upgrades this to a live cancel)
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

// TTS playback simulation: how long the fake phone "speaks" after each done.
// Scenarios raise this to age queued items past the staleness cap.
let ttsHoldMs = 1_200;

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
const decisions = (es: Array<{ decision: string }>) => es.map((e) => e.decision);

// ── assertion bookkeeping ───────────────────────────────────────────────────

let pass = 0; let fail = 0;
function check(id: string, ok: boolean, detail: string): void {
  if (ok) { pass++; log(`  ✅ ${id}  ${detail}`); }
  else { fail++; log(`  ❌ ${id}  ${detail}`); }
}

// Unique markers so ring text-matching can't collide across scenarios/turns —
// or across RUNS: the ring (last 50 decisions) survives on the station between
// harness invocations, so every marker carries a per-run nonce.
const RUN = Date.now().toString(36).slice(-4);

async function idle(): Promise<void> {
  await waitConv('idle', 45_000);
  await sleep(1_700); // clear the autonomous settle gap (brainTaskSettleMs 1500)
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function s4_control(): Promise<void> {
  log('── S4 control: debug/hear in an open followup window runs a turn');
  await idle();
  const mark = frames.length;
  await say('Say the word hello and nothing else.');
  const a = await waitTurnEnd(mark, 60_000);
  check('S4a', a.state === 'done', `first turn terminal state = ${a.state}`);
  await waitConv('followup', 15_000);
  const mark2 = frames.length;
  const goodbye = `And now say the word goodbye, run ${RUN}.`;
  await hear(goodbye);
  const entries = await ringFor(goodbye.slice(0, -1));
  check('S4b', entries.some((e) => e.decision === 'RAN-TURN'),
    `hear-in-followup → [${decisions(entries).join(', ')}] — expect RAN-TURN`);
  const b2 = await waitTurnEnd(mark2, 60_000);
  check('S4c', b2.state === 'done', `follow-up turn terminal state = ${b2.state}`);
}

async function f1_coreDrain(): Promise<void> {
  log('── F1 core drain: two lines heard mid-thinking → ONE combined turn at settle');
  await idle();
  const A = `what color is grass, run ${RUN}`;
  const B = `what color is the sky, run ${RUN}`;
  const mark = frames.length;
  await say('What is two plus two? Answer in one short sentence.');
  await waitConv('thinking', 20_000);
  await hear(`And ${A}?`);
  await hear(`Also ${B}?`);
  const q1 = decisions(await ringFor(A)); const q2 = decisions(await ringFor(B));
  check('F1a', q1.join() === 'queue:busy' && q2.join() === 'queue:busy',
    `both lines queued while thinking → [${q1}], [${q2}]`);

  const end1 = await waitTurnEnd(mark, 60_000);
  check('F1b', end1.state === 'done', `original turn completed: ${end1.state}`);
  // settle = tts-end (~1.2s after done) → drain runs the combined turn
  const drained = await waitTurnEnd(end1.frameIdx + 1, 60_000);
  check('F1c', drained.state === 'done', `drained combined turn ran + completed: ${drained.state}`);
  const d1 = decisions(await ringFor(A)); const d2 = decisions(await ringFor(B));
  check('F1d', d1.join() === 'queue:busy,drain:ran' && d2.join() === 'queue:busy,drain:ran',
    `terminal decisions → [${d1}], [${d2}] — expect queue:busy,drain:ran (the black hole is dead)`);
  // ONE combined turn, not two: no third terminal frame within a settle cycle
  const spoken = frames.slice(drained.frameIdx).filter((f) => f.kind === 'speak').map((f) => f.payload.text).join(' ');
  log(`   combined-turn reply: "${spoken.slice(0, 120)}"`);
  const third = frames.slice(drained.frameIdx + 1).filter(
    (f) => f.kind === 'turn-status' && ['done', 'failed', 'cancelled'].includes(f.payload?.state));
  check('F1e', third.length === 0, `no second drained turn (${third.length} extra terminals) — items were JOINED`);
}

async function f2_mixedAge(): Promise<void> {
  log('── F2 mixed age: a stale item is TRACED skip:stale; a fresh item queued with it still runs');
  await idle();
  const OLD = `what day is it today, run ${RUN}`;
  const NEW = `say the word fresh, run ${RUN}`;
  const mark = frames.length;
  ttsHoldMs = BUSY_QUEUE_MAX_AGE_MS + 3_000; // the reply "speaks" for 23s — ages the early item past the cap
  await say('What is one plus one? Answer in one short sentence.');
  await waitConv('thinking', 20_000);
  await hear(`And ${OLD}?`); // will be >20s old by settle
  const end1 = await waitTurnEnd(mark, 60_000);
  await waitConv('speaking', 15_000);
  log(`   holding TTS ${Math.round(ttsHoldMs / 1000)}s to age the first item…`);
  await sleep(ttsHoldMs - 4_000); // inject the fresh line near the END of the long reply
  ttsHoldMs = 1_200; // drained turn's own TTS back to normal
  await hear(`Please ${NEW}.`);
  const drained = await waitTurnEnd(end1.frameIdx + 1, 60_000);
  check('F2a', drained.state === 'done', `drained turn ran + completed: ${drained.state}`);
  const dOld = decisions(await ringFor(OLD)); const dNew = decisions(await ringFor(NEW));
  check('F2b', dOld.join() === 'queue:busy,skip:stale',
    `stale item terminal decisions → [${dOld}] — VISIBLY dropped (was: silent)`);
  check('F2c', dNew.join() === 'queue:busy,drain:ran',
    `fresh item terminal decisions → [${dNew}] — ran despite the stale neighbor (was: poisoned)`);
}

async function f3_everyTurnKind(): Promise<void> {
  log('── F3 every turn kind drains: speech during an autonomous (self) turn is answered at ITS settle');
  await idle();
  const G = `what is your name, run ${RUN}`;
  const mark = frames.length;
  await think('Say exactly: checking in. Then nothing else.');
  await waitConv('thinking', 20_000);
  await hear(`${G}?`);
  const q = decisions(await ringFor(G));
  check('F3a', q.join() === 'queue:busy', `queued during autonomous turn → [${q}]`);
  const end1 = await waitTurnEnd(mark, 60_000);
  const drained = await waitTurnEnd(end1.frameIdx + 1, 60_000);
  check('F3b', drained.state === 'done', `drained turn after the autonomous settle: ${drained.state} (the ghost class is dead)`);
  const d = decisions(await ringFor(G));
  check('F3c', d.join() === 'queue:busy,drain:ran', `terminal decisions → [${d}]`);
}

async function f4_stopStillQueues(): Promise<void> {
  log('── F4 stop (pre-WI-2): "Stop…" mid-turn queues and is ANSWERED at settle; turn completes');
  await idle();
  const STOP = `Stop. Never mind. Run ${RUN}.`;
  const mark = frames.length;
  await say('Count from one to seven, slowly, one number per sentence.');
  await waitConv('thinking', 20_000);
  await hear(STOP);
  const q = decisions(await ringFor(STOP));
  check('F4a', q.join() === 'queue:busy', `"${STOP}" mid-turn → [${q}] — queued (WI-2 will make this cancel)`);
  const end1 = await waitTurnEnd(mark, 90_000);
  check('F4b', end1.state === 'done', `turn completed: ${end1.state}`);
  const drained = await waitTurnEnd(end1.frameIdx + 1, 60_000);
  const d = decisions(await ringFor(STOP));
  check('F4c', drained.state === 'done' && d.join() === 'queue:busy,drain:ran',
    `stop line answered at settle → [${d}] (no longer silently swallowed)`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`midturn-harness → ${WS_URL} dock=${DOCK} (FIXED-CONTRACT mode: WI-1 busy-queue rework)`);

  // body peer: ack set_target so motion turns don't stall
  await connect({
    id: `${DOCK}-esp32`, component: 'body', kind: 'dock-body-fw', caps: ['servo'],
    topics: ['bodylink'],
    onEvent: (ws, kind, payload) => {
      if (kind === 'command') pub(ws, 'bodylink', 'applied', { parts: payload?.parts ?? {} });
    },
  });

  // phone peer: answers tool RPCs, records frames, simulates TTS playback
  // (speech-status true→false, ttsHoldMs long) — the markers the conversation
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
          const hold = ttsHoldMs; // read at done-time; scenarios adjust between turns
          setTimeout(() => pub(ws, 'agent', 'speech-status', { turnId: payload.turnId, speaking: true }), 150);
          setTimeout(() => pub(ws, 'agent', 'speech-status', { turnId: payload.turnId, speaking: false }), 150 + hold);
        }
      }
    },
  });

  await sleep(500); // let presence/session settle

  const scenarios: Array<[string, () => Promise<void>]> = [
    ['S4', s4_control], ['F1', f1_coreDrain], ['F2', f2_mixedAge],
    ['F3', f3_everyTurnKind], ['F4', f4_stopStillQueues],
  ];
  for (const [name, fn] of scenarios) {
    try { await fn(); }
    catch (err) { fail++; log(`  ❌ ${name}  scenario crashed: ${String(err)}`); }
  }

  console.log(`\n${fail === 0 ? 'PASS ✅' : 'FAIL ❌'}  ${pass} assertions passed, ${fail} failed ` +
    `(fixed-contract mode: pass = every queued utterance ran or was visibly traced)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('midturn-harness failed:', err); process.exit(1); });
