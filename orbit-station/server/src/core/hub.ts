/**
 * The single WebSocket hub. Bridges sockets to the bus:
 *   - inbound `publish` frames  → bus.publish (so modules react)
 *   - bus messages              → outbound `event` frames to topic subscribers
 *
 * Tracks each peer's identity (role, id, dock, component, kind, caps) and
 * subscriptions. Announces peer connect/disconnect on the `station` topic so
 * the directory + console stay live. Resolves `toAddr` (dock, component)
 * directed messages against the live peer set at fan-out time.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { isDirected, type Bus } from './bus.js';
import {
  isInboundFrame,
  type EventFrame,
  type InboundFrame,
  type OutboundFrame,
  type PeerRole,
  type Topic,
} from './protocol.js';

/** How long a silent socket lives. The hub pings every PING_INTERVAL_MS; a
 *  peer that misses PING_MISSES pongs is terminated, so a silently-dead phone
 *  or ESP32 link is detected in ~6 s (the BodyLink §5.1 budget, now hub-side)
 *  instead of at TCP timeout. */
const PING_INTERVAL_MS = 2_000;
const PING_MISSES = 3;

export interface RosterEntry {
  role: PeerRole;
  id: string;
  label?: string;
  dock?: string;
  /** the slot this peer fills within its dock ("phone", "body", …). */
  component?: string;
  /** the software in the slot ("dock-android-app", "dock-body-fw"). */
  kind?: string;
  /** capability tags ("voice", "face", "camera", "servo", …). */
  caps?: string[];
  /** OTA running build (docs/ota.md §3): the monotonic gate — the only version a device reports. */
  build?: number;
  /** peer's remote IP, captured server-side from the socket. */
  ip?: string;
  /** ms epoch of the last frame received from this peer (incl. heartbeats). */
  lastSeen: number;
  /** ms epoch when this peer connected. */
  connectedAt: number;
  /** mesh links this peer reports in its heartbeat. */
  links?: Record<string, boolean>;
  topics: Topic[];
}

interface Peer {
  ws: WebSocket;
  role: PeerRole;
  id: string;
  label?: string;
  dock?: string;
  component?: string;
  kind?: string;
  caps?: string[];
  build?: number;
  ip?: string;
  lastSeen: number;
  connectedAt: number;
  links?: Record<string, boolean>;
  topics: Set<Topic>;
  /** true once the peer has sent a valid `hello`. Pre-hello peers are hidden. */
  announced: boolean;
  /** missed-pong counter for the liveness sweep. */
  missedPongs: number;
}

export class Hub {
  #wss: WebSocketServer;
  #peers = new Map<WebSocket, Peer>();
  #bus: Bus;
  #pingTimer: NodeJS.Timeout;

  constructor(server: HttpServer, bus: Bus) {
    this.#bus = bus;
    this.#wss = new WebSocketServer({ server, path: '/ws' });
    this.#wss.on('connection', (ws, req) => this.#onConnect(ws, req));

    // Liveness sweep: ws-level ping/pong so dead sockets surface fast on every
    // peer type (phones in doze, power-cycled ESP32s). Any pong (or frame)
    // resets the counter.
    this.#pingTimer = setInterval(() => {
      for (const peer of this.#peers.values()) {
        if (peer.ws.readyState !== WebSocket.OPEN) continue;
        if (peer.missedPongs >= PING_MISSES) {
          peer.ws.terminate(); // 'close' handler announces peer-left
          continue;
        }
        peer.missedPongs++;
        try { peer.ws.ping(); } catch { /* close handles it */ }
      }
    }, PING_INTERVAL_MS);
    this.#pingTimer.unref?.();

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
        // directed message: only the addressed peer receives it — by peer id
        // (`to`) or by component address (`toAddr`, resolved right here
        // against the live peer, so reconnects need nothing special).
        if (isDirected(msg)) {
          const byId = msg.to != null && peer.id === msg.to;
          const byAddr = msg.toAddr != null
            && peer.dock === msg.toAddr.dock
            && peer.component === msg.toAddr.component;
          if (!byId && !byAddr) continue;
        }
        // never echo a publisher's own frame back to it — the dock's
        // recognize-request photos (~15KB base64 each) were bouncing back to
        // the phone on every listen. No peer consumes its own publishes
        // (browsers await station replies; the dock awaits station results).
        if (peer.announced && peer.id === msg.source) continue;
        // backpressure guard: a stalled peer (sleeping browser tab, dead
        // phone link) buffers sends in process memory without bound. Shed
        // BROADCAST traffic to it past 1MB buffered; directed frames
        // (signaling, results, tool-calls) still send — they must arrive.
        if (!isDirected(msg) && peer.ws.bufferedAmount > 1_000_000) continue;
        peer.ws.send(json);
      }
    });
  }

  /** Graceful shutdown: stop the ping timer, terminate every peer socket, and
   *  close the WS server — so the process can exit on SIGINT/SIGTERM instead of
   *  hanging on open connections (the "Process didn't exit in 5s" loop). */
  close(): void {
    clearInterval(this.#pingTimer);
    for (const peer of this.#peers.values()) {
      try { peer.ws.terminate(); } catch { /* already gone */ }
    }
    this.#peers.clear();
    try { this.#wss.close(); } catch { /* already closing */ }
  }

  /** Snapshot of connected peers (that have said hello) for the console / API. */
  roster(): RosterEntry[] {
    return [...this.#peers.values()].filter((p) => p.announced).map((p) => ({
      role: p.role,
      id: p.id,
      label: p.label,
      dock: p.dock,
      component: p.component,
      kind: p.kind,
      caps: p.caps,
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
      ip: remoteIp(req), lastSeen: now, connectedAt: now, missedPongs: 0,
    };
    this.#peers.set(ws, peer);

    ws.on('message', (data) => this.#onMessage(peer, data.toString()));
    ws.on('pong', () => { peer.missedPongs = 0; peer.lastSeen = Date.now(); });
    ws.on('close', () => {
      this.#peers.delete(ws);
      if (peer.announced) {
        this.#announce('peer-left', {
          role: peer.role, id: peer.id, dock: peer.dock,
          component: peer.component, kind: peer.kind,
        });
      }
    });
    ws.on('error', () => ws.close());
  }

  #onMessage(peer: Peer, raw: string): void {
    peer.lastSeen = Date.now();   // any frame counts as liveness (incl. heartbeats)
    peer.missedPongs = 0;
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
      case 'hello': {
        peer.role = f.role;
        peer.id = f.id;
        peer.label = f.label;
        peer.dock = f.dock;
        peer.component = f.component;
        peer.kind = f.kind;
        peer.caps = f.caps;
        peer.build = f.build;
        peer.announced = true;
        // Address collision: a second peer claiming an occupied
        // (dock, component) displaces the old one — that's the hardware-swap
        // path (and the stale-socket-racing-a-reconnect path). Newest wins;
        // the displaced peer is told and dropped.
        if (peer.dock && peer.component) {
          for (const other of this.#peers.values()) {
            if (other === peer || !other.announced) continue;
            if (other.dock === peer.dock && other.component === peer.component) {
              this.#send(other.ws, {
                t: 'error',
                message: `displaced: ${peer.dock}/${peer.component} re-claimed by ${peer.id}`,
              });
              other.ws.terminate(); // close handler announces its peer-left
            }
          }
        }
        this.#send(peer.ws, { t: 'welcome', id: peer.id, serverTime: Date.now() });
        this.#announce('peer-joined', {
          role: peer.role, id: peer.id, label: peer.label, dock: peer.dock,
          component: peer.component, kind: peer.kind, caps: peer.caps, build: peer.build,
        });
        break;
      }
      case 'subscribe':
        f.topics.forEach((t) => peer.topics.add(t));
        break;
      case 'unsubscribe':
        f.topics.forEach((t) => peer.topics.delete(t));
        break;
      case 'publish':
        // Capture the mesh links a peer reports in its heartbeat so the
        // roster shows who's connected to what.
        if (f.kind === 'heartbeat') {
          const hb = f.payload as { links?: Record<string, boolean>; build?: number } | null;
          if (hb?.links && typeof hb.links === 'object') peer.links = hb.links;
          // OTA build in the heartbeat (docs/ota.md §3): refresh the roster
          // version so it stays current without a reconnect (e.g. after an OTA
          // where the device rebooted but the socket/peer entry persisted).
          if (typeof hb?.build === 'number' && hb.build !== peer.build) {
            peer.build = hb.build;
            // a build change is OTA-relevant — let modules re-evaluate (the ota
            // module re-checks behind/uptodate + refreshes its console card).
            this.#announce('peer-updated', {
              role: peer.role, id: peer.id, dock: peer.dock, component: peer.component,
              kind: peer.kind, build: peer.build,
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
