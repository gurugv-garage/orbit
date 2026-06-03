/**
 * Dock registry — the station's directory of named docks.
 *
 * A **dock** (e.g. "anne-bot") = one app + one firmware. Everyone knows the
 * station: the dock app and the ESP32 both dial in and declare their `dock`
 * name in `hello` (the ESP32 also reports its phone-facing `bodyAddr`, since it
 * stays a WS *server* for the phone per the BodyLink design). The station
 * groups peers by dock name and **brokers the body address to the matching
 * app** — that's how the app learns where its body lives.
 *
 * Live: on any membership change the station publishes `dock-updated` on the
 * `station` topic. The app subscribes to `station`, sees its dock's `bodyAddr`,
 * and dials its ESP32. The console renders docks from the same stream.
 *
 *   GET /api/docks         all known docks (current membership + bodyAddr)
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { Hub } from '../../core/hub.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { DockInfo, DockMember, PeerRole } from '../../core/protocol.js';

interface PeerEvt { role: PeerRole; id: string; label?: string; dock?: string; bodyAddr?: string; }

export function docksModule(getHub: () => Hub): StationModule {
  const docks = new Map<string, DockInfo>();
  let bus: Bus;

  /** Compute a dock's current makeup from the LIVE roster (fresh ip/lastSeen). */
  function computeDock(name: string): DockInfo {
    const roster = getHub().roster().filter((p) => p.dock === name);
    const app = roster.find((p) => p.role === 'app');
    const fw = roster.find((p) => p.role === 'firmware');

    const info: DockInfo = { name };
    if (app) info.app = member(app, true);
    if (fw) {
      info.firmware = member(fw, true);
      if (fw.bodyAddr) info.bodyAddr = fw.bodyAddr;
    }
    // keep last-known offline members so the console shows "anne-bot (app offline)"
    const prev = docks.get(name);
    if (prev) {
      if (!info.app && prev.app) info.app = { ...prev.app, online: false };
      if (!info.firmware && prev.firmware) info.firmware = { ...prev.firmware, online: false };
      if (!info.bodyAddr && prev.bodyAddr) info.bodyAddr = prev.bodyAddr;
    }
    return info;
  }

  /** Recompute + cache + announce a dock (on membership change). */
  function recompute(name: string): void {
    const info = computeDock(name);
    docks.set(name, info);
    bus.publish({ topic: 'station', kind: 'dock-updated', payload: info, source: 'station' });
  }

  return {
    name: 'docks',
    topic: 'station',
    description: 'named-dock directory (app + firmware grouping; brokers body address to the app)',

    init(b) {
      bus = b;
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        if (msg.kind === 'peer-joined' || msg.kind === 'peer-left') {
          const p = msg.payload as PeerEvt;
          if (p.dock) recompute(p.dock);
        }
      });
    },

    async route(ctx: RouteContext) {
      if (ctx.subPath === '/' && ctx.req.method === 'GET') {
        // Recompute from the live roster so ip/lastSeen are current for the UI's
        // heartbeat display (it polls this). Known docks not currently grouped
        // still appear (offline members retained by computeDock).
        const names = new Set(docks.keys());
        for (const p of getHub().roster()) if (p.dock) names.add(p.dock);
        const fresh = [...names].map(computeDock);
        fresh.forEach((d) => docks.set(d.name, d));
        json(ctx.res, 200, fresh);
        return true;
      }
      return false;
    },
  };
}

function member(
  p: { role: PeerRole; id: string; label?: string; ip?: string; lastSeen: number; links?: Record<string, boolean> },
  online: boolean,
): DockMember {
  return { role: p.role, id: p.id, label: p.label, online, ip: p.ip, lastSeen: p.lastSeen, links: p.links };
}
