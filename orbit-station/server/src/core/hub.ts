/**
 * The single WebSocket hub. Bridges sockets to the bus:
 *   - inbound `publish` frames  → bus.publish (so modules + mind react)
 *   - bus messages              → outbound `event` frames to topic subscribers
 *
 * Tracks each peer's role, id, and subscriptions. Announces peer connect/
 * disconnect on the `station` topic so the console can show a live roster.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Bus } from './bus.js';
import {
  isInboundFrame,
  type EventFrame,
  type InboundFrame,
  type OutboundFrame,
  type PeerRole,
  type Topic,
} from './protocol.js';

export interface RosterEntry {
  role: PeerRole;
  id: string;
  label?: string;
  dock?: string;
  bodyAddr?: string;
  /** OTA running build (docs/OTA.md §3): the monotonic gate — the only version a device reports. */
  build?: number;
  /** peer's remote IP, captured server-side from the socket. */
  ip?: string;
  /** ms epoch of the last frame received from this peer (incl. heartbeats). */
  lastSeen: number;
  /** ms epoch when this peer connected. */
  connectedAt: number;
  /** mesh links this peer reports in its heartbeat (app: body/llm; fw: phoneClient). */
  links?: Record<string, boolean>;
  topics: Topic[];
}

interface Peer {
  ws: WebSocket;
  role: PeerRole;
  id: string;
  label?: string;
  /** the named dock this peer belongs to (app/firmware only). */
  dock?: string;
  /** firmware only: its phone-facing BodyLink address ("<ip>:17317"). */
  bodyAddr?: string;
  /** OTA running build (docs/OTA.md §3): the monotonic gate. */
  build?: number;
  /** remote IP from the socket. */
  ip?: string;
  lastSeen: number;
  connectedAt: number;
  links?: Record<string, boolean>;
  topics: Set<Topic>;
  /** true once the peer has sent a valid `hello`. Pre-hello peers are hidden. */
  announced: boolean;
}

export class Hub {
  #wss: WebSocketServer;
  #peers = new Map<WebSocket, Peer>();
  #bus: Bus;

  constructor(server: HttpServer, bus: Bus) {
    this.#bus = bus;
    this.#wss = new WebSocketServer({ server, path: '/ws' });
    this.#wss.on('connection', (ws, req) => this.#onConnect(ws, req));

    // Bus → sockets: every bus message becomes an event frame for subscribers.
    bus.on('*', (msg) => {
      const frame: EventFrame = {
        t: 'event',
        topic: msg.topic,
        kind: msg.kind,
        payload: msg.payload,
        ts: msg.ts,
      };
      const json = JSON.stringify(frame);
      for (const peer of this.#peers.values()) {
        if (!peer.topics.has(msg.topic)) continue;
        // directed message: only the addressed peer receives it.
        if (msg.to != null && peer.id !== msg.to) continue;
        peer.ws.send(json);
      }
    });
  }

  /** Snapshot of connected peers (that have said hello) for the console / API. */
  roster(): RosterEntry[] {
    return [...this.#peers.values()].filter((p) => p.announced).map((p) => ({
      role: p.role,
      id: p.id,
      label: p.label,
      dock: p.dock,
      bodyAddr: p.bodyAddr,
      build: p.build,
      ip: p.ip,
      lastSeen: p.lastSeen,
      connectedAt: p.connectedAt,
      links: p.links,
      topics: [...p.topics],
    }));
  }

  #onConnect(ws: WebSocket, req: IncomingMessage): void {
    const now = Date.now();
    const peer: Peer = {
      ws, role: 'fake', id: 'unknown', topics: new Set(), announced: false,
      ip: remoteIp(req), lastSeen: now, connectedAt: now,
    };
    this.#peers.set(ws, peer);

    ws.on('message', (data) => this.#onMessage(peer, data.toString()));
    ws.on('close', () => {
      this.#peers.delete(ws);
      if (peer.announced) this.#announce('peer-left', { role: peer.role, id: peer.id, dock: peer.dock });
    });
    ws.on('error', () => ws.close());
  }

  #onMessage(peer: Peer, raw: string): void {
    peer.lastSeen = Date.now();   // any frame counts as liveness (incl. heartbeats)
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return this.#send(peer.ws, { t: 'error', message: 'invalid JSON' });
    }
    if (!isInboundFrame(frame)) {
      return this.#send(peer.ws, { t: 'error', message: 'missing frame type' });
    }
    const f = frame as InboundFrame;

    switch (f.t) {
      case 'hello':
        peer.role = f.role;
        peer.id = f.id;
        peer.label = f.label;
        peer.dock = f.dock;
        peer.bodyAddr = f.bodyAddr;
        peer.build = f.build;
        peer.announced = true;
        this.#send(peer.ws, { t: 'welcome', id: peer.id, serverTime: Date.now() });
        this.#announce('peer-joined', {
          role: peer.role, id: peer.id, label: peer.label, dock: peer.dock,
          bodyAddr: peer.bodyAddr, build: peer.build,
        });
        break;
      case 'subscribe':
        f.topics.forEach((t) => peer.topics.add(t));
        break;
      case 'unsubscribe':
        f.topics.forEach((t) => peer.topics.delete(t));
        break;
      case 'publish':
        // Capture the mesh links a peer reports in its heartbeat (app: body/llm;
        // firmware: phoneClient) so the roster shows who's connected to what.
        if (f.kind === 'heartbeat') {
          const hb = f.payload as { links?: Record<string, boolean>; build?: number } | null;
          if (hb?.links && typeof hb.links === 'object') peer.links = hb.links;
          // OTA build in the heartbeat (docs/OTA.md §3): refresh the roster
          // version so it stays current without a reconnect (e.g. after an OTA
          // where the device rebooted but the socket/peer entry persisted).
          if (typeof hb?.build === 'number' && hb.build !== peer.build) {
            peer.build = hb.build;
            // a build change is OTA-relevant — let modules re-evaluate (the ota
            // module re-checks behind/uptodate + refreshes its console card).
            this.#announce('peer-updated', {
              role: peer.role, id: peer.id, dock: peer.dock, build: peer.build,
            });
          }
        }
        this.#bus.publish({ topic: f.topic, kind: f.kind, payload: f.payload, source: peer.id });
        break;
    }
  }

  #announce(kind: string, payload: unknown): void {
    this.#bus.publish({ topic: 'station', kind, payload, source: 'station' });
  }

  #send(ws: WebSocket, frame: OutboundFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }
}

/** Best-effort remote IP, honoring a reverse proxy's X-Forwarded-For. */
function remoteIp(req: IncomingMessage): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0]!.trim();
  // strip IPv6-mapped IPv4 prefix (::ffff:192.168.1.5 → 192.168.1.5)
  return req.socket.remoteAddress?.replace(/^::ffff:/, '');
}
