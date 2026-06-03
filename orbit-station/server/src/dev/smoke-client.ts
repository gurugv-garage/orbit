/**
 * Manual smoke client — NOT part of the running system.
 *
 * The real producers are the dock app (holds a WS, publishes agent-core events
 * on 'obs') and the ESP32 body (WS client, publishes 'bodylink' profile/state).
 * They connect and disconnect freely; the station tolerates absence.
 *
 * This script just lets you eyeball the UI end-to-end before those are wired:
 * it connects two short-lived WS peers that emit a few realistic frames, then
 * stays connected so the console shows live peers. Run it by hand:
 *
 *     npm run smoke            (with the server already up)
 *
 * Delete or ignore once the app + body are connecting for real.
 */

import { WebSocket } from 'ws';
import type { AgentEventDto } from '../modules/observability/types.js';

const URL = process.env.STATION_WS ?? 'ws://localhost:8099/ws';

interface HelloExtra { dock?: string; bodyAddr?: string }
function peer(role: string, id: string, label: string, onOpen: (ws: WebSocket) => void, extra: HelloExtra = {}): WebSocket {
  const ws = new WebSocket(URL, { rejectUnauthorized: false });
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', role, id, label, ...extra }));
    onOpen(ws);
  });
  ws.on('error', (e) => console.error(`[${id}]`, (e as Error).message));
  return ws;
}
const pub = (ws: WebSocket, topic: string, kind: string, payload: unknown) =>
  ws.send(JSON.stringify({ t: 'publish', topic, kind, payload }));

// one agent-core turn, as the dock app would emit it ────────────────────────
let SEQ = 0;
function emitTurn(ws: WebSocket, sessionId: string, turnNo: number) {
  const turnId = `turn-${turnNo}`;
  const e = (kind: AgentEventDto['kind'], data?: AgentEventDto['data']) =>
    pub(ws, 'obs', 'event', { sessionId, turnId, seq: SEQ++, kind, ts: Date.now(), data } satisfies AgentEventDto);

  e('TurnStart');
  e('StepStart');
  e('ToolExecutionStart', { toolCallId: `tc${SEQ}`, toolName: 'move_body', args: { part: 'neck', state: 'lookUp' } });
  setTimeout(() => {
    e('ToolExecutionEnd', { toolCallId: `tc${SEQ}`, toolName: 'move_body', isError: false });
    e('StepEnd', { stopReason: 'toolUse', model: 'gemini-2.5-flash', usage: { inputTokens: 410, outputTokens: 30 } });
    e('StepStart');
    e('MessageEnd', { text: 'Looking up now!' });
    e('StepEnd', { stopReason: 'stop', model: 'gemini-2.5-flash', usage: { inputTokens: 470, outputTokens: 16 } });
    e('TurnEnd');
  }, 400);
}

// the two peers of one dock, "anne-bot" — exactly how the real app + ESP32 will hello.
peer('app', 'anne-bot-app', 'anne-bot phone (smoke)', (ws) => {
  const sid = `sess-${Date.now().toString(36)}`;
  let n = 0;
  setInterval(() => emitTurn(ws, sid, n++), 5000);
  emitTurn(ws, sid, n++);
}, { dock: 'anne-bot' });

peer('firmware', 'anne-bot-esp32', 'anne-bot body (smoke)', (ws) => {
  ws.send(JSON.stringify({ t: 'subscribe', topics: ['bodylink'] }));
  const profile = {
    body: {
      device_id: 'xiao-esp32-smoke',
      name: 'dock-body-smoke',
      parts: {
        neck: { description: 'pitch', home: { pulse_width_us: 1500 }, params: { pulse_width_us: { type: 'int', unit: 'us', range: [500, 2500] }, duration_ms: { type: 'int', unit: 'ms', range: [0, null], default: 400 } } },
        foot: { description: 'yaw', home: { pulse_width_us: 1500 }, params: { pulse_width_us: { type: 'int', unit: 'us', range: [500, 2500] }, duration_ms: { type: 'int', unit: 'ms', range: [0, null], default: 400 } } },
      },
    },
  };
  const state: Record<string, Record<string, number>> = { neck: { pulse_width_us: 1500 }, foot: { pulse_width_us: 1500 } };
  pub(ws, 'bodylink', 'profile', profile);
  setInterval(() => pub(ws, 'bodylink', 'state', state), 500);
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.t === 'event' && f.topic === 'bodylink' && f.kind === 'command') {
      for (const [p, params] of Object.entries(f.payload?.parts ?? {})) {
        state[p] = { ...state[p], ...(params as Record<string, number>) };
      }
    }
  });
}, { dock: 'anne-bot', bodyAddr: '192.168.1.42:17317' });

console.log(`smoke client connected to ${URL} — Ctrl-C to stop`);
