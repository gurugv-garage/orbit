/**
 * Docks module — publishes the dock directory (composition + live presence).
 *
 * A **dock** (e.g. "anne-bot") is a named composition of components (phone,
 * body, …; docs/decision-traces/server-brain-impl.md §2). Every component dials the station
 * and declares its address (dock, component) + capabilities in `hello`. The
 * [Directory] (directory.ts) tracks composition; this module wires it to the
 * bus + console:
 *
 *   - on any membership change: `dock-updated` (undirected, station topic)
 *     for consoles, and a `presence` frame DIRECTED to each online component
 *     of that dock — the sibling-awareness loop (the app knows the body is
 *     offline, the body knows the phone is gone) with no device↔device
 *     traffic. Presence also re-sends on a slow cadence so devices
 *     self-heal after missed frames.
 *
 *   GET /api/docks                     all known docks (composition + live state)
 *   GET /api/docks/unclaimed           live devices with no dock binding yet
 *   POST   /api/docks/bind             claim a device → dock (deviceId, dock)
 *   DELETE /api/docks/bind/:deviceId   forget a device's binding (re-park unclaimed)
 *   PUT    /api/docks/:name/manifest   edit a dock's expected components
 *   DELETE /api/docks/:name            forget a dock (refused while live)
 *
 * Runtime dock binding (docs/modules/runtime-dock-binding.md): a device
 * dials in with only its stable hardware id and learns its dock name back from
 * the station. An unbound device rides the roster "unclaimed" (no dock) and is
 * surfaced here to be claimed.
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { PresenceFrame } from '../../core/protocol.js';
import type { Directory } from './directory.js';
import type { Hub, RosterEntry } from '../../core/hub.js';
import type { BindingStore } from './bindings.js';

/** slow re-send so devices that missed a presence frame self-heal. */
const PRESENCE_RESEND_MS = 10_000;

interface PeerEvt {
  role?: string; id?: string; dock?: string; component?: string;
  kind?: string; caps?: string[]; build?: number; label?: string;
}

export function docksModule(
  directory: Directory,
  getHub: () => Hub,
  bindings: BindingStore,
): StationModule {
  let bus: Bus;

  /** Drop persisted test/web/sim cruft, announcing each removal to consoles.
   *  Ephemeral peers are never persisted going forward (Directory.noteSeen), so
   *  this just clears anything older builds left behind + any test dock whose
   *  real trace is gone. */
  function pruneEphemeral(): void {
    for (const name of directory.pruneEphemeral()) {
      bus.publish({ topic: 'station', kind: 'dock-removed', payload: { name }, source: 'station' });
    }
  }

  /** A device left a dock (unbind / move): reap its last-known ghost from every
   *  OTHER dock so it stops showing as an offline phantom there, and tell consoles
   *  (dock-updated if the dock still has slots, dock-removed if it's now empty).
   *  `exceptDock` = where the device is live now (its new/current dock). */
  function reapGhosts(deviceId: string, exceptDock?: string): void {
    for (const name of directory.forgetComponentEverywhere(deviceId, exceptDock)) {
      if (directory.dockExists(name)) announce(name);
      else bus.publish({ topic: 'station', kind: 'dock-removed', payload: { name }, source: 'station' });
    }
  }

  /** Publish the composed view: console broadcast + directed sibling presence. */
  function announce(dock: string): void {
    const info = directory.dockInfo(dock);
    bus.publish({ topic: 'station', kind: 'dock-updated', payload: info, source: 'station' });

    const presence: PresenceFrame = {
      dock,
      components: info.components.map((c) => ({
        component: c.component, kind: c.kind, online: c.online, build: c.build,
      })),
    };
    for (const c of info.components) {
      if (!c.online) continue;
      bus.publish({
        topic: 'station', kind: 'presence', payload: presence, source: 'station',
        toAddr: { dock, component: c.component },
      });
    }
  }

  return {
    name: 'docks',
    topic: 'station',
    description: 'dock directory: composition (manifest), live presence, capability addressing',

    init(b) {
      bus = b;
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        if (msg.kind === 'peer-joined' || msg.kind === 'peer-left' || msg.kind === 'peer-updated') {
          const p = msg.payload as PeerEvt;
          if (!p.dock) return;
          if (msg.kind !== 'peer-left') {
            const live = getHub().roster().find((r) => r.id === p.id && r.dock === p.dock);
            if (live) directory.noteSeen(live);
          }
          // An EPHEMERAL dock (test/web/sim — never persisted) that just lost its
          // last live peer no longer exists in the directory: tell consoles to drop
          // the card instead of leaving a ghost. Real (persisted) docks still
          // announce, so they render offline.
          if (!directory.dockExists(p.dock)) {
            bus.publish({ topic: 'station', kind: 'dock-removed', payload: { name: p.dock }, source: 'station' });
          } else {
            announce(p.dock);
          }
        }
      });

      const timer = setInterval(() => {
        for (const d of directory.docks()) {
          if (d.components.some((c) => c.online)) announce(d.name);
        }
      }, PRESENCE_RESEND_MS);
      timer.unref?.();

      // one-time on boot: clear test/web/sim docks older builds persisted.
      pruneEphemeral();
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (subPath === '/' && req.method === 'GET') {
        json(res, 200, directory.docks());
        return true;
      }

      // Unclaimed devices: live, announced, non-browser peers with no dock yet
      // (docs/modules/runtime-dock-binding.md). Task peers (component
      // 'task:*') are background jobs, never a claimable device.
      if (subPath === '/unclaimed' && req.method === 'GET') {
        const unclaimed = getHub().roster().filter(
          (p) => p.role !== 'browser' && !p.dock && !p.component?.startsWith('task:'),
        ).map((p) => ({
          id: p.id, kind: p.kind, label: p.label, caps: p.caps,
          ip: p.ip, build: p.build, lastSeen: p.lastSeen, connectedAt: p.connectedAt,
        }));
        json(res, 200, unclaimed);
        return true;
      }

      // Claim a live device onto a dock: persist the binding + adopt it on the
      // live peer (mutate dock, re-announce, push welcome) so it goes live with
      // no reconnect. The slot is derived from the device's kind.
      if (subPath === '/bind' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { deviceId?: unknown; dock?: unknown };
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
        const dock = typeof body.dock === 'string' ? body.dock.trim() : '';
        if (!deviceId || !dock) {
          json(res, 400, { error: 'deviceId and dock are required' });
          return true;
        }
        const claimed = getHub().claim(deviceId, dock);
        if (!claimed) {
          // No live peer with that id — bind anyway so it adopts on next hello.
          bindings.bind(deviceId, dock);
          json(res, 202, { ok: true, dock, live: false });
          return true;
        }
        // The peer-updated announce makes docksModule call directory.noteSeen,
        // so the dock appears in GET /api/docks on the next tick. Reap this device
        // from any OTHER dock's last-known so it doesn't haunt its old dock.
        reapGhosts(deviceId, dock);
        json(res, 200, { ok: true, ...claimed, live: true });
        return true;
      }

      const unbind = subPath.match(/^\/bind\/([^/]+)$/);
      if (unbind && req.method === 'DELETE') {
        const deviceId = decodeURIComponent(unbind[1]!);
        const removed = bindings.unbind(deviceId);
        // Re-park the LIVE peer too (not just the DB): clear its dock in place,
        // announce, push welcome{dock:null}. Without this the device lingers as a
        // ghost of its old dock and never shows up in /unclaimed to be re-claimed.
        const reparked = getHub().unclaim(deviceId);
        // Reap its last-known ghost from EVERY dock (it now belongs to none).
        reapGhosts(deviceId);
        json(res, removed || reparked ? 200 : 404, { ok: removed || reparked, reparked });
        return true;
      }
      const m = subPath.match(/^\/([^/]+)\/manifest$/);
      if (m && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { manifest?: string[] };
        if (!Array.isArray(body.manifest) || body.manifest.some((s) => typeof s !== 'string')) {
          json(res, 400, { error: 'manifest must be a string[]' });
          return true;
        }
        const dock = decodeURIComponent(m[1]!);
        directory.setManifest(dock, body.manifest);
        announce(dock);
        json(res, 200, directory.dockInfo(dock));
        return true;
      }
      const del = subPath.match(/^\/([^/]+)$/);
      if (del && req.method === 'DELETE') {
        const dock = decodeURIComponent(del[1]!);
        const ok = directory.forget(dock);
        if (ok) {
          bus.publish({ topic: 'station', kind: 'dock-removed', payload: { name: dock }, source: 'station' });
          json(res, 200, { ok: true });
        } else {
          json(res, 409, { error: 'dock has live components (or is unknown) — disconnect first' });
        }
        return true;
      }
      return false;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export type { RosterEntry };
