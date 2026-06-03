/**
 * Config module — central config management.
 *
 *   - DEFAULTS live here in code (the safe baseline every device falls back to).
 *   - Overrides are applied at runtime via HTTP PATCH or the console.
 *   - On any change, the merged effective config (or just the changed keys) is
 *     PUSHED on the 'config' topic. The ESP32 firmware and the dock app
 *     subscribe to 'config' and apply pushes live — no polling.
 *
 * Config is namespaced by scope so one device only listens to what's relevant:
 *   config.station.*   station-wide
 *   config.dock.*      dock app
 *   config.body.*      esp32 body firmware
 *
 * Read:   GET   /api/config            full effective config
 *         GET   /api/config/:scope     one scope
 * Write:  PATCH /api/config/:scope     merge keys, push the delta
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';

type Scope = 'station' | 'dock' | 'body';
type ConfigTree = Record<Scope, Record<string, unknown>>;

const DEFAULTS: ConfigTree = {
  station: {
    logLevel: 'info',
    heartbeatSec: 10,
  },
  dock: {
    // mirrors knobs the dock app cares about; safe baseline.
    idleAnimations: true,
    gazeTracking: true,
    ttsRate: 1.0,
    cameraDefaultOn: false,
    thinkingLevel: 'low',
  },
  body: {
    // esp32 servo body knobs.
    maxSpeedDegPerSec: 120,
    neckPitchLimitDeg: 45,
    footYawLimitDeg: 90,
    idleGestures: true,
  },
};

export function configModule(): StationModule {
  // deep copy so DEFAULTS stays pristine for fallback semantics.
  const effective: ConfigTree = structuredClone(DEFAULTS);
  let bus: Bus;

  function pushDelta(scope: Scope, delta: Record<string, unknown>): void {
    bus.publish({
      topic: 'config',
      kind: 'changed',
      payload: { scope, delta, effective: effective[scope] },
      source: 'station',
    });
  }

  return {
    name: 'config',
    topic: 'config',
    description: 'central config: defaults + push-on-change to firmware/app',

    init(b) {
      bus = b;
      // When a fresh peer subscribes, the console can request a snapshot; we
      // also push the full config on the 'config' topic at boot so any peer
      // already connected gets the baseline.
      bus.on('station', (msg) => {
        if (msg.kind === 'peer-joined') {
          // re-broadcast current effective config so the new peer syncs.
          (['station', 'dock', 'body'] as Scope[]).forEach((s) =>
            bus.publish({
              topic: 'config',
              kind: 'snapshot',
              payload: { scope: s, effective: effective[s] },
              source: 'station',
            }),
          );
        }
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/' && req.method === 'GET') {
        json(res, 200, { defaults: DEFAULTS, effective });
        return true;
      }

      const scopeMatch = subPath.match(/^\/(station|dock|body)$/);
      if (scopeMatch) {
        const scope = scopeMatch[1] as Scope;
        if (req.method === 'GET') {
          json(res, 200, { scope, effective: effective[scope], defaults: DEFAULTS[scope] });
          return true;
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
          const delta = JSON.parse(await readBody(req)) as Record<string, unknown>;
          Object.assign(effective[scope], delta);
          pushDelta(scope, delta);
          json(res, 200, { scope, applied: delta, effective: effective[scope] });
          return true;
        }
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
