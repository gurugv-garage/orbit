/**
 * fake-phone — drives the SERVER BRAIN end-to-end with no hardware.
 *
 * Connects two peers of one dock ("smoke-brain"): a phone (voice/face/camera)
 * and a body (servo). Streams transcript partials (pre-warm), sends a
 * turn-request, ANSWERS every tool-call instantly (the fire-and-forget
 * contract), and prints a per-turn latency waterfall:
 *
 *   request → accepted → first-speak → done   (+ set_target arrivals at the body)
 *
 * Run (station up; set GEMINI_API_KEY etc. or point brainModel at a LAN
 * model via the config console):
 *
 *     npm run smoke:brain
 *     npm run smoke:brain -- "look up and say hi"
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const URL = process.env.STATION_WS ?? 'ws://localhost:8099/ws';
const DOCK = process.env.SMOKE_DOCK ?? 'smoke-brain';
const UTTERANCE = process.argv[2] ?? 'hello there! give me a happy wiggle';

function connect(opts: {
  id: string; component: string; kind: string; caps: string[];
  topics: string[]; onEvent: (ws: WebSocket, kind: string, payload: any, topic: string) => void;
}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { rejectUnauthorized: false });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'hello', role: 'device', id: opts.id, dock: DOCK,
        component: opts.component, kind: opts.kind, caps: opts.caps,
        label: `${DOCK} ${opts.component} (fake)`,
      }));
      ws.send(JSON.stringify({ t: 'subscribe', topics: opts.topics }));
      // deterministic brain-status handshake (hello after subscribe)
      if (opts.topics.includes('agent')) {
        ws.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'hello', payload: {} }));
      }
      resolve(ws);
    });
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'event') opts.onEvent(ws, f.kind, f.payload, f.topic);
      if (f.t === 'error') console.log(`  [${opts.component}] station error: ${f.message}`);
    });
    ws.on('error', reject);
  });
}

const pub = (ws: WebSocket, topic: string, kind: string, payload: unknown) =>
  ws.send(JSON.stringify({ t: 'publish', topic, kind, payload }));

const t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(5)}ms`;

async function main() {
  let turnStartedAt = 0;
  let firstSpeakAt = 0;
  let speakCount = 0;

  // body: receives set_target commands, echoes applied (the BodyLink contract)
  await connect({
    id: `${DOCK}-esp32`, component: 'body', kind: 'dock-body-fw', caps: ['servo'],
    topics: ['bodylink'],
    onEvent: (ws, kind, payload) => {
      if (kind === 'command') {
        const parts = Object.entries(payload?.parts ?? {})
          .map(([p, v]: [string, any]) => `${p}=${v.pulse_width_us}µs`).join(' ');
        console.log(`${at()}  [body ] set_target  ${parts}`);
        pub(ws, 'bodylink', 'applied', { parts: payload?.parts ?? {} });
      }
    },
  });

  // phone: the brain's conversational surface
  const phone = await connect({
    id: `${DOCK}-phone`, component: 'phone', kind: 'dock-android-app',
    caps: ['voice', 'face', 'camera'],
    topics: ['agent', 'station', 'bodylink'],
    onEvent: (ws, kind, payload, topic) => {
      if (topic === 'bodylink' && kind === 'digest') return; // noisy; fine
      if (kind === 'brain-status') {
        console.log(`${at()}  [phone] brain-status ready=${payload?.ready}`);
        return;
      }
      if (kind === 'tool-call') {
        console.log(`${at()}  [phone] tool-call    ${payload.name} ${JSON.stringify(payload.args)}`);
        // fire-and-forget contract: ack instantly with a dispatch status
        pub(ws, 'agent', 'tool-result', {
          reqId: payload.reqId, toolCallId: payload.toolCallId, turnId: payload.turnId,
          content: `${payload.name} dispatched`, isError: false,
        });
        return;
      }
      if (kind === 'speak') {
        if (firstSpeakAt === 0) firstSpeakAt = Date.now();
        speakCount++;
        console.log(`${at()}  [phone] speak #${payload.seq}    "${payload.text}"`);
        return;
      }
      if (kind === 'turn-status') {
        console.log(`${at()}  [phone] turn-status  ${payload.state}${payload.code ? ` (${payload.code}${payload.detail ? `: ${payload.detail}` : ''})` : ''}`);
        if (payload.state === 'done' || payload.state === 'failed' || payload.state === 'cancelled') {
          const ttfs = firstSpeakAt > 0 ? firstSpeakAt - turnStartedAt : null;
          console.log(`\n  waterfall: request→${payload.state} ${Date.now() - turnStartedAt}ms` +
            (ttfs != null ? `, first speak at ${ttfs}ms, ${speakCount} sentences` : ', no speech'));
          // settle markers so TurnSettled shows up in obs
          pub(ws, 'agent', 'speech-status', { turnId: payload.turnId, speaking: true });
          setTimeout(() => {
            pub(ws, 'agent', 'speech-status', { turnId: payload.turnId, speaking: false });
            setTimeout(() => process.exit(0), 300);
          }, 200);
        }
      }
    },
  });

  // streaming partials → the brain pre-warms (session + profile resolved)
  const words = UTTERANCE.split(' ');
  for (let i = 1; i <= words.length; i++) {
    pub(phone, 'agent', 'transcript', {
      utteranceId: 'u1', text: words.slice(0, i).join(' '), isFinal: i === words.length,
    });
    await new Promise((r) => setTimeout(r, 120));
  }

  turnStartedAt = Date.now();
  console.log(`${at()}  [phone] turn-request "${UTTERANCE}"`);
  pub(phone, 'agent', 'turn-request', {
    turnId: randomUUID(),
    trigger: { kind: 'user', text: UTTERANCE },
    context: { state: 'You can see someone in front of you (fake smoke peer).', battery: 80 },
  });

  // safety net: don't hang forever if the brain never answers
  setTimeout(() => {
    console.log('\n  no terminal turn-status within 90s — check station logs / API keys');
    process.exit(1);
  }, 90_000);
}

main().catch((err) => {
  console.error('fake-phone failed:', err);
  process.exit(1);
});
