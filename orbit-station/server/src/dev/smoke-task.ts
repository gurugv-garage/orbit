/**
 * smoke:task — drives the TASK lifecycle end-to-end against a live station, no
 * hardware (docs/TASKS_V1.md §11). Connects a fake phone (opens a session by
 * sending one turn), starts a task via REST, and prints the unsolicited
 * autonomous turn frames the task triggers (accepted(autonomous)/speak/done) plus
 * the instance state from REST. Proves the wire→speak chain with a real server.
 *
 *   npm run start                       # station up (another shell)
 *   npm run smoke:task                  # default: remind-every every 3s, 3 times
 *   npm run smoke:task -- count-then-report '{"target":3}'
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const WS_URL = process.env.STATION_WS ?? 'ws://localhost:8099/ws';
const HTTP = process.env.STATION_HTTP ?? 'http://localhost:8099';
const DOCK = process.env.SMOKE_DOCK ?? 'smoke-task';
const DEF = process.argv[2] ?? 'remind-every';
// PARAMS only applies to the REST-start path; --say mode uses argv[3] as the utterance.
const PARAMS = DEF === '--say' ? {} : JSON.parse(process.argv[3] ?? '{"message":"drink water","interval":"3s"}');

const log = (...a: unknown[]) => console.log(...a);

function connectPhone(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'device', id: `phone-${randomUUID().slice(0, 6)}`, dock: DOCK, component: 'phone', kind: 'dock-android-app', caps: ['voice', 'face', 'camera'], label: `${DOCK} phone (smoke)` }));
      ws.send(JSON.stringify({ t: 'subscribe', topics: ['agent'] }));
      ws.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'hello', payload: {} }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t !== 'event' || f.topic !== 'agent') return;
      const p = f.payload ?? {};
      if (f.kind === 'turn-status') log(`  ← turn-status ${p.state}${p.autonomous ? ' (AUTONOMOUS)' : ''} ${String(p.turnId).slice(0, 12)}`);
      else if (f.kind === 'speak') log(`  ← SPEAK "${p.text}"`);
      else if (f.kind === 'tool-call') {
        // answer any tool-call instantly so the opening turn can complete
        ws.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'tool-result', payload: { reqId: p.reqId, toolCallId: p.toolCallId, content: 'ok', isError: false } }));
      }
    });
    ws.on('error', reject);
  });
}

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${HTTP}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: text }; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log(`smoke:task — dock=${DOCK} def=${DEF} params=${JSON.stringify(PARAMS)}`);
  const phone = await connectPhone();
  await sleep(300);

  // CONVERSATIONAL mode: `npm run smoke:task -- --say "remind me in 1 minute to take a bath"`
  // sends a real user utterance and lets the LLM decide — the true end-user flow.
  if (DEF === '--say') {
    const utterance = process.argv[3] ?? 'remind me in 1 minute to take a bath';
    log(`CONVERSATIONAL: user says "${utterance}"`);
    phone.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'turn-request', payload: { turnId: `t-${randomUUID().slice(0, 6)}`, trigger: { kind: 'user', text: utterance }, context: { state: 'idle' } } }));
    log('waiting for the brain to act (10s)…');
    await sleep(10_000);
    const insts = await rest('GET', `/api/brain/${DOCK}/instances`);
    log('RESULT instances started:', JSON.stringify(insts.json));
    const ran = Array.isArray(insts.json) && insts.json.length > 0;
    log(ran ? `✅ the brain STARTED a task (${insts.json.map((i: any) => i.name).join(', ')}) — did NOT refuse`
            : '❌ no task started — the brain may have refused');
    for (const i of (Array.isArray(insts.json) ? insts.json : [])) await rest('POST', `/api/brain/${DOCK}/instances/${i.instanceId}/stop`);
    phone.close();
    process.exit(ran ? 0 : 2);
  }

  // open a conversational session: send a turn-request (the brain opens lazily).
  log('1. opening a session (turn-request)…');
  phone.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'turn-request', payload: { turnId: `t-${randomUUID().slice(0, 6)}`, trigger: { kind: 'user', text: 'hello' }, context: { state: 'idle' } } }));
  await sleep(2500); // let the opening turn settle (needs a model; tolerate failure)

  // start the task via REST
  log(`2. POST /instances (${DEF})…`);
  const start = await rest('POST', `/api/brain/${DOCK}/instances`, { name: DEF, params: PARAMS });
  log('   →', start.status, JSON.stringify(start.json));
  const id = start.json?.instanceId;
  if (!id) { log('   no instanceId — is a session open? (the opening turn may need a model key)'); process.exit(1); }

  // watch the autonomous turns the task triggers
  log('3. watching for autonomous task turns (8s)…');
  await sleep(8000);

  log('4. GET /instances/:id …');
  const info = await rest('GET', `/api/brain/${DOCK}/instances/${id}`);
  log('   state:', info.json?.state, '| status:', JSON.stringify(info.json?.status));

  log('5. POST /instances/:id/stop …');
  await rest('POST', `/api/brain/${DOCK}/instances/${id}/stop`);
  await sleep(500);
  phone.close();
  log('done.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
