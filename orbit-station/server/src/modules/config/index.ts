/**
 * Config module — central, persistent, versioned config with push-on-change.
 *
 *   - The REGISTRY (registry.ts) declares every knob: scope, value type, a Zod
 *     schema, and a default. DEFAULTS are the safe baseline baked into device
 *     builds, so a device works with NO station present.
 *   - The ConfigStore (store.ts) persists overrides in orbit.db and stamps a
 *     `lastUpdated` on each write. Reads merge override-over-default.
 *   - On any change (or a force-push), the changed key is PUSHED on the
 *     'config' topic as {scope,key,value,lastUpdated}. The ESP32 firmware and
 *     dock app subscribe to 'config', compare lastUpdated, and apply live.
 *   - On a peer joining, every effective entry is snapshotted to it so a
 *     freshly-booted device syncs to the station's current values.
 *
 * Scopes namespace by listener: config.station.* / config.dock.* / config.body.*
 *
 * Read:   GET  /api/config                 all effective entries (typed + lastUpdated + jsonSchema)
 *         GET  /api/config/:scope          one scope
 *         GET  /api/config/export          flat scope→key→value dump (build bake)
 * Write:  PATCH /api/config/:scope         { key: value, ... } — validate, persist, push deltas
 *         POST  /api/config/:scope/:key/push   re-push current value (force, no change)
 *         POST  /api/config/:scope/:key/reset  drop override → registry default
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Scope } from './registry.js';
import { ConfigStore, type EffectiveEntry, type ValidationError } from './store.js';

function isError(r: EffectiveEntry | ValidationError): r is ValidationError {
  return (r as ValidationError).error != null;
}

export function configModule(): StationModule {
  const store = new ConfigStore();
  let bus: Bus;

  /** Push one effective entry to listeners (changed or forced). */
  function pushEntry(e: EffectiveEntry): void {
    bus.publish({
      topic: 'config',
      kind: 'changed',
      payload: { scope: e.scope, key: e.key, type: e.type, value: e.value, lastUpdated: e.lastUpdated },
      source: 'station',
    });
  }

  return {
    name: 'config',
    topic: 'config',
    description: 'central config: persistent, versioned, push-on-change to firmware/app',

    init(b) {
      bus = b;
      // A freshly-connected peer gets a full snapshot so it syncs to current
      // values (then stays live via 'changed' pushes).
      bus.on('station', (msg) => {
        if (msg.kind === 'peer-joined') {
          for (const e of store.list()) {
            bus.publish({
              topic: 'config',
              kind: 'snapshot',
              payload: { scope: e.scope, key: e.key, type: e.type, value: e.value, lastUpdated: e.lastUpdated },
              source: 'station',
            });
          }
        }
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/' && req.method === 'GET') {
        json(res, 200, { entries: store.list() });
        return true;
      }

      if (subPath === '/export' && req.method === 'GET') {
        json(res, 200, store.export());
        return true;
      }

      // force re-push a single key's current value (no change needed).
      const pushM = subPath.match(/^\/(station|dock|body)\/([^/]+)\/push$/);
      if (pushM && req.method === 'POST') {
        const e = store.get(pushM[1]!, decodeURIComponent(pushM[2]!));
        if (!e) { json(res, 404, { error: 'unknown key' }); return true; }
        pushEntry(e);
        json(res, 200, { pushed: e });
        return true;
      }

      // reset a key to its registry default.
      const resetM = subPath.match(/^\/(station|dock|body)\/([^/]+)\/reset$/);
      if (resetM && req.method === 'POST') {
        const r = store.reset(resetM[1]!, decodeURIComponent(resetM[2]!));
        if (isError(r)) { json(res, 404, r); return true; }
        pushEntry(r);
        json(res, 200, { reset: r });
        return true;
      }

      const scopeMatch = subPath.match(/^\/(station|dock|body)$/);
      if (scopeMatch) {
        const scope = scopeMatch[1] as Scope;
        if (req.method === 'GET') {
          json(res, 200, { scope, entries: store.list(scope) });
          return true;
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
          const delta = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const applied: EffectiveEntry[] = [];
          const errors: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(delta)) {
            const r = store.set(scope, key, value);
            if (isError(r)) errors[key] = r.issues ?? r.error;
            else { applied.push(r); pushEntry(r); }
          }
          const code = Object.keys(errors).length && !applied.length ? 400 : 200;
          json(res, code, { scope, applied, errors });
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
