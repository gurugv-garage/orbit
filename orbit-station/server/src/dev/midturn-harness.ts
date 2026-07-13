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
 *   F4  voice-stop — "Stop. Never mind." mid-turn CANCELS the reply and opens
 *                    a listening window (WI-2 — was: impossible by voice)
 *   F5  precision  — content with embedded stop words ("…the bus stop…") is
 *                    queued + answered, never cancelled (WI-2's guard)
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
  // Since Addendum 10, THINKING-phase speech MERGES (F10 covers it); the queue's
  // remaining user-turn domain is SPEAKING — inject during the reply's TTS.
  log('── F1 core drain: two lines heard mid-SPEAKING → ONE combined turn at settle');
  await idle();
  const A = `what color is grass, run ${RUN}`;
  const B = `what color is the sky, run ${RUN}`;
  const mark = frames.length;
  ttsHoldMs = 8_000; // long enough to inject both lines during the reply's TTS
  await say('What is two plus two? Answer in one short sentence.');
  const end1 = await waitTurnEnd(mark, 60_000);
  check('F1b', end1.state === 'done', `original turn completed: ${end1.state}`);
  await waitConv('speaking', 15_000);
  ttsHoldMs = 1_200; // drained turn's own TTS back to normal
  await hear(`And ${A}?`);
  await hear(`Also ${B}?`);
  const q1 = decisions(await ringFor(A)); const q2 = decisions(await ringFor(B));
  check('F1a', q1.join() === 'queue:busy' && q2.join() === 'queue:busy',
    `both lines queued while speaking → [${q1}], [${q2}]`);
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
  const end1 = await waitTurnEnd(mark, 60_000);
  await waitConv('speaking', 15_000);
  await hear(`And ${OLD}?`); // early in the long TTS → >20s old by settle
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

async function f4_voiceStop(): Promise<void> {
  log('── F4 voice-stop (WI-2 + dismissal): "Stop. Never mind." mid-turn CANCELS + stands DOWN');
  await idle();
  const scenarioStart = Date.now();
  const mark = frames.length;
  await say('Count from one to seven, slowly, one number per sentence.');
  await waitConv('thinking', 20_000);
  await hear('Stop. Never mind.');
  const e = (await ring()).filter((x) => x.at >= scenarioStart && x.text.startsWith('Stop'));
  check('F4a', decisions(e).join() === 'stop:dismiss', `mid-turn stop → [${decisions(e)}]`);
  const end1 = await waitTurnEnd(mark, 90_000);
  check('F4b', end1.state === 'cancelled', `turn terminal state = ${end1.state} — voice stopped it (was: impossible)`);
  const m = await waitConv('idle', 10_000);
  check('F4c', m === 'idle', `conversation after dismissal = ${m} — stood down, no window (re-engage via tap/wake)`);
}

async function f8_dismissClearsAll(): Promise<void> {
  log('── F8 dismissal (Addendum 5.1): dismissal while busy stands down; queued items traced, not drained');
  await idle();
  const HELD = `what is nine plus nine, run ${RUN}`;
  const scenarioStart = Date.now();
  const mark = frames.length;
  ttsHoldMs = 8_000; // inject during the reply's TTS (thinking-phase speech now merges)
  await say('Count from one to nine, slowly, one number per sentence.');
  const end1 = await waitTurnEnd(mark, 60_000);
  await waitConv('speaking', 15_000);
  ttsHoldMs = 1_200;
  await hear(`And ${HELD}?`); // queued while speaking
  await hear("Stop. I'm not talking to you."); // dismissal while speaking
  const e = (await ring()).filter((x) => x.at >= scenarioStart);
  const stopE = e.filter((x) => x.text.startsWith('Stop'));
  const heldE = e.filter((x) => x.text.includes(HELD));
  check('F8a', decisions(stopE).join() === 'stop:dismiss', `dismissal decision → [${decisions(stopE)}]`);
  check('F8b', decisions(heldE).join() === 'queue:busy,skip:dismissed',
    `queued item after dismissal → [${decisions(heldE)}] — traced, never drained`);
  check('F8c', end1.state === 'done', `counting turn had completed (${end1.state}); dismissal killed its TTS`);
  const m = await waitConv('idle', 10_000);
  // no drained turn may follow — watch for any terminal frame in the next 10s
  await sleep(10_000);
  const extras = frames.slice(end1.frameIdx + 1).filter(
    (f) => f.kind === 'turn-status' && ['done', 'failed', 'cancelled'].includes(f.payload?.state));
  check('F8d', m === 'idle' && extras.length === 0,
    `stood down (mode=${m}), no turn drained after dismissal (${extras.length} extras)`);
}

async function f5_stopFalsePositives(): Promise<void> {
  log('── F5 stop precision: content with embedded stop words queues (never cancels)');
  await idle();
  const BUS = `bus stop, run ${RUN}`;
  const mark = frames.length;
  ttsHoldMs = 6_000;
  await say('What is three plus three? Answer in one short sentence.');
  const end1 = await waitTurnEnd(mark, 60_000);
  await waitConv('speaking', 15_000);
  ttsHoldMs = 1_200;
  await hear(`Tell me about the ${BUS}.`);
  const q = decisions(await ringFor(BUS));
  check('F5a', q.join() === 'queue:busy', `"…the bus stop…" mid-speaking → [${q}] — queued, NOT cancelled`);
  check('F5b', end1.state === 'done', `turn completed despite the stop word: ${end1.state}`);
  const drained = await waitTurnEnd(end1.frameIdx + 1, 60_000);
  const d = decisions(await ringFor(BUS));
  check('F5c', drained.state === 'done' && d.join() === 'queue:busy,drain:ran',
    `content line answered at settle → [${d}]`);
}

async function f6_cannedWake(): Promise<void> {
  log('── F6 canned wake ack (WI-4): "hey orbit" → spoken ack with NO LLM turn');
  await idle();
  const mark = frames.length;
  const heardAt = Date.now();
  await hear('Hey orbit.');
  // the canned envelope should be near-instant: adopt (accepted+autonomous) → speak → done
  await sleep(600);
  const got = frames.slice(mark);
  const speak = got.find((f) => f.kind === 'speak');
  const accepted = got.find((f) => f.kind === 'turn-status' && f.payload?.state === 'accepted');
  check('F6a', speak != null && String(speak.payload.text).toLowerCase().includes('did you call'),
    `ack spoken: "${speak ? speak.payload.text : 'NONE'}"`);
  check('F6b', speak != null && speak.at - heardAt < 500,
    `hear→speak ${speak ? speak.at - heardAt : '∞'}ms — expect <500ms (was 6–7s via LLM)`);
  check('F6c', accepted?.payload?.autonomous === true
    && !got.some((f) => f.kind === 'turn-status' && f.payload?.state === 'thinking'),
    'adopted envelope, and NO LLM turn ran for the ack');
  const m = (await conv()).mode;
  check('F6d', m === 'listening' || m === 'speaking' || m === 'followup',
    `window open after wake (mode=${m})`);
  // wake+command still runs a REAL turn
  await idle();
  const mark2 = frames.length;
  await hear(`Hey orbit, say the word ping, run ${RUN}.`);
  const end = await waitTurnEnd(mark2, 60_000);
  check('F6e', end.state === 'done', `wake+command still runs an LLM turn: ${end.state}`);
}

async function f7_tapThenSilence(): Promise<void> {
  log('── F7 (review fix): tap-interrupt with queued speech + SILENCE → drained at window close');
  await idle();
  const HELD = `what is the capital of France, run ${RUN}`;
  const mark = frames.length;
  ttsHoldMs = 8_000; // inject during TTS (thinking-phase speech now merges)
  await say('Count from one to five, slowly, one number per sentence.');
  const end1 = await waitTurnEnd(mark, 60_000);
  await waitConv('speaking', 15_000);
  ttsHoldMs = 1_200;
  await hear(`And ${HELD}?`); // queued while speaking
  await post('/debug/event', { event: 'tap' }); // tap-interrupt: silence + open listening
  await waitConv('listening', 5_000);
  const q = decisions(await ringFor(HELD));
  check('F7a', q.join() === 'queue:busy', `queued line held through the tap-interrupt → [${q}]`);
  check('F7b', end1.state === 'done', `counting turn had completed (${end1.state}); tap killed only its TTS`);
  // user says NOTHING: the listening window (8s) expires → idle → the settle
  // chokepoint fires → the held line drains (was: stranded forever, untraced)
  const drained = await waitTurnEnd(end1.frameIdx + 1, 30_000);
  const d = decisions(await ringFor(HELD));
  check('F7c', drained.state === 'done' && d.join() === 'queue:busy,drain:ran',
    `after window close: [${d}], drained turn ${drained.state} — nothing stranded`);
}

async function f9_pause(): Promise<void> {
  log('── F9 pause (Addendum 5.3): "Wait." mid-reply shuts up and LISTENS (not a dismissal)');
  await idle();
  const scenarioStart = Date.now();
  const mark = frames.length;
  await say('Count from one to nine, slowly, one number per sentence.');
  await waitConv('thinking', 20_000);
  await hear('Wait. Hold on a second.');
  const e = (await ring()).filter((x) => x.at >= scenarioStart && x.text.startsWith('Wait'));
  check('F9a', decisions(e).join() === 'stop:pause', `mid-turn wait → [${decisions(e)}]`);
  const end1 = await waitTurnEnd(mark, 30_000);
  check('F9b', end1.state === 'cancelled', `counting turn: ${end1.state} — it shut up`);
  const m = await waitConv(['listening', 'idle'], 10_000);
  check('F9c', m === 'listening', `conversation after wait = ${m} — LISTENING for what they say next`);
  // and what they say next runs a turn
  const mark2 = frames.length;
  await hear(`Okay, what is eight plus eight, run ${RUN}?`);
  const end2 = await waitTurnEnd(mark2, 60_000);
  check('F9d', end2.state === 'done', `the held-back question ran after the pause: ${end2.state}`);
}

async function f10_thinkingMerge(): Promise<void> {
  log('── F10 merge (Addendum 10): speech mid-THINKING cancels + re-asks merged; obs shows cancelled');
  // a) correction folds in: ONE final answer reflecting the correction
  await idle();
  const mark = frames.length;
  await say('What is twelve plus twelve? Answer with just the number.');
  await waitConv('thinking', 20_000);
  await hear('Actually, multiply them instead.');
  const e = (await ring()).filter((x) => x.text.startsWith('Actually, multiply'));
  check('F10a', decisions(e).join() === 'merge:supersede', `mid-thinking correction → [${decisions(e)}]`);
  const t1 = await waitTurnEnd(mark, 60_000);
  const t2 = await waitTurnEnd(t1.frameIdx + 1, 60_000);
  const spoken = frames.slice(mark).filter((f) => f.kind === 'speak').map((f) => String(f.payload.text)).join(' ');
  check('F10b', t1.state === 'cancelled' && t2.state === 'done',
    `original ${t1.state}, merged ${t2.state}`);
  check('F10c', spoken.includes('144') && !spoken.includes('24'),
    `one MERGED answer: "${spoken.slice(0, 60)}" — expect 144, not 24`);
  // obs must record the cancelled turn (user requirement)
  const sid = (await (await fetch(`${HTTP}/api/brain/${DOCK}/sessions`)).json() as Array<{ sessionId: string }>)[0]!.sessionId;
  const obs = await (await fetch(`${HTTP}/api/observability/sessions/${sid}`)).json() as
    { turns: Array<{ state?: string; merges?: number; trigger?: { text?: string } }> };
  const twelve = obs.turns.filter((t) => t.trigger?.text?.includes('twelve plus twelve'));
  check('F10d', twelve.some((t) => t.state === 'cancelled') && twelve.some((t) => t.state === 'done' && t.merges === 1),
    `obs terminal states for the pair: [${twelve.map((t) => `${t.state}/m${t.merges ?? 0}`).join(', ')}]`);
  // b) repeated question → ONE answer, no follow-up duplicate
  await idle();
  const mark2 = frames.length;
  const Q = `what is five plus four, run ${RUN}`;
  await say(`Tell me ${Q}? Answer with just the number.`);
  await waitConv('thinking', 20_000);
  await hear(`Tell me ${Q}?`); // the classic repeat-into-the-silence
  const r1 = await waitTurnEnd(mark2, 60_000);
  const r2 = await waitTurnEnd(r1.frameIdx + 1, 60_000);
  await sleep(8_000); // any spurious drained duplicate would land here
  const extras = frames.slice(r2.frameIdx + 1).filter(
    (f) => f.kind === 'turn-status' && ['done', 'failed', 'cancelled'].includes(f.payload?.state));
  check('F10e', r1.state === 'cancelled' && r2.state === 'done' && extras.length === 0,
    `repeat dedupes: ${r1.state}+${r2.state}, ${extras.length} extra turns — ONE answer`);
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
    ['F3', f3_everyTurnKind], ['F4', f4_voiceStop], ['F5', f5_stopFalsePositives],
    ['F6', f6_cannedWake], ['F7', f7_tapThenSilence], ['F8', f8_dismissClearsAll],
    ['F9', f9_pause], ['F10', f10_thinkingMerge],
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
