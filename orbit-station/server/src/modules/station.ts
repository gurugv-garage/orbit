/**
 * Station module — meta endpoints about the station itself.
 *   GET /api/station/health    liveness + uptime
 *   GET /api/station/modules   what's registered
 *   GET /api/station/peers     live WS roster (docks, firmware, browsers)
 */

import { json } from '../core/http.js';
import type { Hub } from '../core/hub.js';
import type { StationModule, RouteContext } from '../core/module.js';

export function stationModule(getModules: () => StationModule[], getHub: () => Hub): StationModule {
  const startedAt = Date.now();
  return {
    name: 'station',
    topic: 'station',
    description: 'station meta: health, module registry, live peer roster',
    init() {
      /* presence is announced by the hub */
    },
    async route(ctx: RouteContext) {
      const { res, subPath, req } = ctx;
      if (req.method !== 'GET') return false;
      if (subPath === '/health') {
        json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
        return true;
      }
      if (subPath === '/modules') {
        json(
          res,
          200,
          getModules().map((m) => ({ name: m.name, topic: m.topic, description: m.description })),
        );
        return true;
      }
      if (subPath === '/peers') {
        json(res, 200, getHub().roster());
        return true;
      }
      return false;
    },
  };
}
