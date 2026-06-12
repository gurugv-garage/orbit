/**
 * BodyLink module — the body's command path + state cache, per dock.
 *
 * The MotionExecutor (motion.ts) is the body's SINGLE MASTER: the brain's
 * move/gesture tools and the console sliders both route through it, in one
 * process (the phone↔ESP32 link is retired — see node-dock/bodylink/DESIGN.md
 * banner). The firmware holds ONE socket (to the station) and speaks the
 * BodyLink vocabulary on this topic:
 *
 *   station → body:  kind 'command'  payload = set_target body (directed toAddr)
 *   body → station:  kind 'profile'  capability profile (on connect)
 *                    kind 'state' / 'applied'  reported per-part state
 *                    kind 'event' / 'error'    async notices
 *
 * Phone/console awareness is a ~1 Hz `digest` — body status is DISPLAY-ONLY
 * and staleness-tolerant by design (impl plan corner case 23): directed to
 * the dock's face component + an undirected copy for browser consoles.
 *
 *   GET  /api/bodylink/profile?dock=    capability profile
 *   GET  /api/bodylink/state?dock=      latest reported state
 *   POST /api/bodylink/command          { dock?, parts } → executor (clamped)
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { Hub } from '../../core/hub.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from './motion.js';

const DIGEST_MIN_INTERVAL_MS = 1_000;

interface ParamSpec {
  type: 'int' | 'float';
  unit: string;
  range: [number | null, number | null];
  default?: number;
}
interface BodyProfile {
  body: {
    device_id: string;
    name: string;
    parts: Record<string, { description?: string; home?: Record<string, number>; params: Record<string, ParamSpec> }>;
  };
}

interface DockBody {
  profile: BodyProfile | null;
  state: Record<string, Record<string, number>>;
  lastDigestAt: number;
}

export function bodylinkModule(deps: {
  directory: Directory;
  motion: MotionExecutor;
  getHub: () => Hub;
}): StationModule {
  let bus: Bus;
  const docks = new Map<string, DockBody>();

  function body(dock: string): DockBody {
    let d = docks.get(dock);
    if (!d) {
      d = { profile: null, state: {}, lastDigestAt: 0 };
      docks.set(dock, d);
    }
    return d;
  }

  /** the sender's dock, from its hello (tenancy: never from the payload). */
  function dockOf(peerId: string): string | undefined {
    return deps.getHub().roster().find((p) => p.id === peerId)?.dock;
  }

  function clampToProfile(dock: string, parts: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
    const profile = body(dock).profile;
    if (!profile) return parts;
    const out: Record<string, Record<string, number>> = {};
    for (const [part, params] of Object.entries(parts)) {
      const spec = profile.body.parts[part];
      if (!spec) continue; // UNKNOWN_PART — drop; body would also reject
      out[part] = {};
      for (const [k, v] of Object.entries(params)) {
        const ps = spec.params[k];
        if (!ps) continue;
        let val = v;
        const [lo, hi] = ps.range;
        if (lo != null && val < lo) val = lo;
        if (hi != null && val > hi) val = hi;
        out[part]![k] = val;
      }
    }
    return out;
  }

  /** ~1 Hz body-status digest: directed to the dock's face component (the
   *  phone's status panel) + undirected for consoles. */
  function maybeDigest(dock: string, force = false): void {
    const d = body(dock);
    const now = Date.now();
    if (!force && now - d.lastDigestAt < DIGEST_MIN_INTERVAL_MS) return;
    d.lastDigestAt = now;
    const online = deps.motion.isOnline(dock);
    const payload = { dock, online, state: d.state, targets: deps.motion.targets(dock), ts: now };
    bus.publish({ topic: 'bodylink', kind: 'digest', payload, source: 'station' });
    const face = deps.directory.resolveCap(dock, 'face');
    if (face?.component) {
      bus.publish({
        topic: 'bodylink', kind: 'digest', payload, source: 'station',
        toAddr: { dock, component: face.component },
      });
    }
  }

  return {
    name: 'bodylink',
    topic: 'bodylink',
    description: 'body command path + state cache (motion executor = the single master)',

    init(b) {
      bus = b;
      bus.on('bodylink', (msg) => {
        if (msg.source === 'station') return;
        const dock = dockOf(msg.source);
        if (!dock) return;
        const d = body(dock);
        if (msg.kind === 'profile') {
          d.profile = msg.payload as BodyProfile;
          maybeDigest(dock, true);
        } else if (msg.kind === 'state' || msg.kind === 'applied') {
          if (msg.kind === 'state') d.state = msg.payload as Record<string, Record<string, number>>;
          else Object.assign(d.state, (msg.payload as { parts?: Record<string, Record<string, number>> })?.parts ?? {});
          maybeDigest(dock);
        }
      });

      // presence flips (body on/offline) are digest-worthy immediately
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        if (msg.kind !== 'peer-joined' && msg.kind !== 'peer-left') return;
        const p = msg.payload as { dock?: string; caps?: string[] } | null;
        if (p?.dock && (p.caps ?? []).includes('servo')) maybeDigest(p.dock, true);
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath, url } = ctx;
      const dockParam = url.searchParams.get('dock') ?? undefined;
      /** default when no ?dock=: the one dock with an ONLINE body wins; else
       *  the single known dock (console back-compat). Smoke/test docks linger
       *  in the directory, so "exactly one known" almost never holds — online
       *  servo presence is the signal that matters. */
      function pickDock(): string | undefined {
        if (dockParam) return dockParam;
        const online = deps.directory.docks().map((d) => d.name)
          .filter((name) => deps.motion.isOnline(name));
        if (online.length === 1) return online[0];
        const known = [...new Set([...docks.keys(), ...deps.directory.docks().map((d) => d.name)])];
        return known.length === 1 ? known[0] : undefined;
      }

      if (subPath === '/profile' && req.method === 'GET') {
        const dock = pickDock();
        json(res, 200, (dock && body(dock).profile) ?? { error: 'no body connected', dock });
        return true;
      }
      if (subPath === '/state' && req.method === 'GET') {
        const dock = pickDock();
        json(res, 200, dock ? { dock, online: deps.motion.isOnline(dock), state: body(dock).state, targets: deps.motion.targets(dock) } : {});
        return true;
      }
      // operator set_target → the same master the brain uses (last write wins).
      if (subPath === '/command' && req.method === 'POST') {
        const cmd = JSON.parse(await readBody(req)) as { dock?: string; parts: Record<string, Record<string, number>> };
        const dock = cmd.dock ?? pickDock();
        if (!dock) { json(res, 400, { error: 'which dock? pass {dock}' }); return true; }
        const parts = clampToProfile(dock, cmd.parts ?? {});
        const partsUs: Record<string, number> = {};
        let durationMs: number | undefined;
        for (const [part, params] of Object.entries(parts)) {
          if (typeof params.pulse_width_us === 'number') partsUs[part] = params.pulse_width_us;
          if (typeof params.duration_ms === 'number') durationMs = params.duration_ms;
        }
        deps.motion.setTargets(dock, partsUs, durationMs);
        maybeDigest(dock, true);
        json(res, 200, { sent: { dock, parts } });
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
