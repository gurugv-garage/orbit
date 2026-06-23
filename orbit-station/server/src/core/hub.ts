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
  componentForKind,
  isInboundFrame,
  type EventFrame,
  type InboundFrame,
  type OutboundFrame,
  type PeerRole,
  type Topic,
} from './protocol.js';

/** The station's deviceId→dock binding, injected so the hub can resolve a
 *  device's dock from its stable id when it dials in without one, and persist a
 *  binding when a console claims it (docs/decision-traces/runtime-dock-binding.md). */
export interface DockBindings {
  lookup(deviceId: string): string | undefined;
  bind(deviceId: string, dock: string): void;
  unbind(deviceId: string): boolean;
}

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
  #bindings?: DockBindings;

  constructor(server: HttpServer, bus: Bus, bindings?: DockBindings) {
    this.#bus = bus;
    this.#bindings = bindings;
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

  /**
   * Claim an unclaimed (or rebind a claimed) live device to a dock
   * (docs/decision-traces/runtime-dock-binding.md). Persists the binding, mutates
   * the live peer's dock/component in place, announces `peer-updated` so
   * dock-keyed modules re-resolve, and pushes a fresh welcome frame so the
   * device adopts + caches the name without reconnecting. The slot is derived
   * from the device's `kind`. Returns the peer's resolved (dock, component), or
   * undefined if no live announced peer has that id.
   */
  claim(deviceId: string, dock: string): { dock: string; component?: string } | undefined {
    const peer = [...this.#peers.values()].find((p) => p.announced && p.id === deviceId);
    if (!peer) return undefined;
    const component = componentForKind(peer.kind) ?? peer.component;
    // Persist the binding + tell the device its dock via `welcome`. The DEVICE
    // decides what to do with it (docs/decision-traces/runtime-dock-binding.md):
    // a FIRST claim (was unclaimed) is adopted live — nothing dock-specific was
    // built yet; a CHANGE of an existing dock makes the device RESTART ITSELF
    // (app: relaunch process; firmware: esp_restart) so no stale in-memory trace
    // survives. That old-vs-new compare lives on the device, so the station path
    // stays a plain rebind — no special move handling here.
    this.#bindings?.bind(deviceId, dock);
    peer.dock = dock;
    peer.component = component;
    // Slot collision: a DIFFERENT live device already holding (dock, component)
    // is unbound + dropped — it reconnects UNCLAIMED. One dock can't have two
    // phones in its phone slot.
    if (component) this.#displaceFromSlot(dock, component, deviceId);
    this.#announce('peer-updated', {
      role: peer.role, id: peer.id, label: peer.label, dock: peer.dock,
      component: peer.component, kind: peer.kind, caps: peer.caps, build: peer.build,
    });
    this.#send(peer.ws, {
      t: 'welcome', id: peer.id, serverTime: Date.now(),
      dock: peer.dock, component: peer.component ?? null,
    });
    return { dock, component };
  }

  /** Un-claim a LIVE device: clear its dock/component in place, announce the
   *  change, and push a welcome{dock:null} so it re-parks UNCLAIMED immediately
   *  (without waiting for a reconnect). Returns true if a live peer was re-parked.
   *  The binding-store delete is the caller's job (docks REST); this fixes the
   *  live-roster side so the device doesn't linger as a ghost of its old dock. */
  unclaim(deviceId: string): boolean {
    const peer = [...this.#peers.values()].find((p) => p.announced && p.id === deviceId);
    if (!peer || !peer.dock) return false;
    peer.dock = undefined;
    peer.component = undefined;
    this.#announce('peer-updated', {
      role: peer.role, id: peer.id, label: peer.label, dock: undefined,
      component: undefined, kind: peer.kind, caps: peer.caps, build: peer.build,
    });
    this.#send(peer.ws, { t: 'welcome', id: peer.id, serverTime: Date.now(), dock: null, component: null });
    return true;
  }

  /** Evict any live peer (other than `exceptId`) occupying (dock, component) so a
   *  new claimant can take the slot. CRITICAL: we forget its binding AND push a
   *  welcome{dock:null} BEFORE terminating — the welcome tells the device to clear
   *  its cached dock, so when it redials it comes back UNCLAIMED. Without the
   *  welcome, the displaced device would re-assert its stale hello.dock, the hub
   *  would re-seed its binding, and the two devices would ping-pong the slot. */
  #displaceFromSlot(dock: string, component: string, exceptId: string): void {
    for (const other of this.#peers.values()) {
      if (!other.announced || other.id === exceptId) continue;
      if (other.dock !== dock || other.component !== component) continue;
      this.#bindings?.unbind(other.id);
      this.#send(other.ws, { t: 'welcome', id: other.id, serverTime: Date.now(), dock: null, component: null });
      try { other.ws.terminate(); } catch { /* already gone */ }
    }
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
        // Runtime dock binding (docs/decision-traces/runtime-dock-binding.md):
        // the station's deviceId→dock binding is the SOURCE OF TRUTH. It ALWAYS
        // wins over whatever dock the device asserts in hello — a console claim
        // must never be silently overwritten by a device's stale compiled-in
        // DOCK_NAME. So: if a binding exists, use it (ignoring hello.dock). Only
        // when there's NO binding does a device-supplied dock seed one (the
        // first-run dev-override / self-claim convenience). A peer still
        // dock-less after this is UNCLAIMED: it rides the roster, idles, and
        // surfaces in the console to be claimed. The slot is derived from `kind`.
        const bound = this.#bindings?.lookup(peer.id);
        if (bound) {
          peer.dock = bound;            // binding wins, even over hello.dock
        } else if (peer.dock) {
          this.#bindings?.bind(peer.id, peer.dock);  // seed from a self-claim
        }
        if (peer.dock) peer.component = componentForKind(peer.kind) ?? peer.component;
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
        this.#send(peer.ws, {
          t: 'welcome', id: peer.id, serverTime: Date.now(),
          dock: peer.dock ?? null, component: peer.component ?? null,
        });
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
