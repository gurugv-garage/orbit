/**
 * Docks module — publishes the dock directory (composition + live presence).
 *
 * A **dock** (e.g. "anne-bot") is a named composition of components (phone,
 * body, …; docs/SERVER-BRAIN-IMPL.md §2). Every component dials the station
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
 *   PUT /api/docks/:name/manifest      edit a dock's expected components
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { PresenceFrame } from '../../core/protocol.js';
import type { Directory } from './directory.js';
import type { Hub, RosterEntry } from '../../core/hub.js';

/** slow re-send so devices that missed a presence frame self-heal. */
const PRESENCE_RESEND_MS = 10_000;

interface PeerEvt {
  role?: string; id?: string; dock?: string; component?: string;
  kind?: string; caps?: string[]; build?: number; label?: string;
}

export function docksModule(directory: Directory, getHub: () => Hub): StationModule {
  let bus: Bus;

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
          announce(p.dock);
        }
      });

      const timer = setInterval(() => {
        for (const d of directory.docks()) {
          if (d.components.some((c) => c.online)) announce(d.name);
        }
      }, PRESENCE_RESEND_MS);
      timer.unref?.();
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (subPath === '/' && req.method === 'GET') {
        json(res, 200, directory.docks());
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
