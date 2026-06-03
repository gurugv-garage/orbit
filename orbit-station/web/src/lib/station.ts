/**
 * StationClient — the browser UI's single WS connection to orbit-station.
 *
 * Connects as a 'browser' peer, subscribes to all topics, auto-reconnects, and
 * dispatches incoming `event` frames to topic listeners. The UI also publishes
 * (e.g. nothing today — control goes via REST — but the channel is here).
 */

import type { EventFrame, OutboundFrame, Topic } from './protocol';

type EventListener = (e: EventFrame) => void;
type StatusListener = (connected: boolean) => void;

const ALL_TOPICS: Topic[] = ['obs', 'config', 'bodylink', 'mind', 'station'];

export class StationClient {
  #ws: WebSocket | null = null;
  #url: string;
  #listeners = new Set<EventListener>();
  #statusListeners = new Set<StatusListener>();
  #reconnectTimer: number | null = null;
  #closed = false;

  constructor(url?: string) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    this.#url = url ?? `${scheme}://${location.host}/ws`;
  }

  connect(): void {
    this.#closed = false;
    this.#open();
  }

  #open(): void {
    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'browser', id: `ui-${Math.random().toString(36).slice(2, 7)}`, label: 'console' }));
      ws.send(JSON.stringify({ t: 'subscribe', topics: ALL_TOPICS }));
      this.#statusListeners.forEach((l) => l(true));
    };
    ws.onmessage = (m) => {
      let frame: OutboundFrame;
      try { frame = JSON.parse(m.data as string); } catch { return; }
      if (frame.t === 'event') this.#listeners.forEach((l) => l(frame));
    };
    ws.onclose = () => {
      this.#statusListeners.forEach((l) => l(false));
      if (!this.#closed) this.#scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer != null) return;
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, 1500);
  }

  onEvent(l: EventListener): () => void { this.#listeners.add(l); return () => this.#listeners.delete(l); }
  onStatus(l: StatusListener): () => void { this.#statusListeners.add(l); return () => this.#statusListeners.delete(l); }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
  }
}

/** REST helpers — control + reads go over HTTP; live stream over WS. */
export const api = {
  get: <T>(path: string): Promise<T> => fetch(`/api${path}`).then((r) => r.json() as Promise<T>),
  patch: <T>(path: string, body: unknown): Promise<T> =>
    fetch(`/api${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<T>),
  post: <T>(path: string, body: unknown): Promise<T> =>
    fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<T>),
};
