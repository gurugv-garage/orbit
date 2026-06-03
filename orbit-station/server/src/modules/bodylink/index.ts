/**
 * BodyLink console module — direct body control, bypassing the dock app.
 *
 * The station is a relay between an operator (browser console) and a body peer
 * (ESP32 firmware, or the MuJoCo sim, connected over the WS hub as role
 * 'firmware'). It speaks the BodyLink vocabulary from node-dock/bodylink/DESIGN.md:
 *
 *   operator → body:  kind 'command'  payload = a `set_target` body  (parts → params)
 *   body → station:   kind 'profile'  payload = the capability profile
 *                     kind 'state'    payload = reported per-part state (10 Hz)
 *                     kind 'applied'  payload = ack of a state-changing command
 *
 * The station keeps the latest profile + state so a console that connects late
 * renders immediately. Commands are validated against the profile's ranges
 * before relay (the body clips too — this is the brain-side safety net §2.3).
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';

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

export function bodylinkModule(): StationModule {
  let bus: Bus;
  let profile: BodyProfile | null = null;
  let state: Record<string, Record<string, number>> = {};

  function clampToProfile(parts: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
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

  return {
    name: 'bodylink',
    topic: 'bodylink',
    description: 'direct body control console (bypasses the dock app)',

    init(b) {
      bus = b;
      bus.on('bodylink', (msg) => {
        if (msg.source === 'station') return;
        if (msg.kind === 'profile') profile = msg.payload as BodyProfile;
        else if (msg.kind === 'state') state = msg.payload as Record<string, Record<string, number>>;
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/profile' && req.method === 'GET') {
        json(res, 200, profile ?? { error: 'no body connected' });
        return true;
      }
      if (subPath === '/state' && req.method === 'GET') {
        json(res, 200, state);
        return true;
      }
      // operator sends a set_target; we clamp then relay to body peers.
      if (subPath === '/command' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { parts: Record<string, Record<string, number>> };
        const parts = clampToProfile(body.parts ?? {});
        bus.publish({ topic: 'bodylink', kind: 'command', payload: { parts }, source: 'station' });
        json(res, 200, { sent: { parts } });
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
