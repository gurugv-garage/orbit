/**
 * Config module — central, persistent, versioned config with per-peer push.
 *
 *   - The REGISTRY (registry.ts) declares every knob: flat global key, value
 *     type, a Zod schema, a default, and UI tags. Keys are SHARED — routing is
 *     NOT derived from the key.
 *   - The ConfigStore (store.ts) persists overrides in orbit.db, stamps a
 *     `lastUpdated` per write, and validates against the entry's schema.
 *   - INTEREST: each peer announces the set of keys it cares about (hardcoded
 *     in the component's init) via a `config`/`interest` publish. The station
 *     records it and pushes — directed to that peer — a snapshot of those keys,
 *     then live `changed` pushes for them. A peer only ever receives keys it
 *     registered. The console UI reads the interest map to show who wants what.
 *
 * Read:   GET  /api/config              all effective entries (typed + lastUpdated + tags + interested)
 *         GET  /api/config/export       flat key→value dump (build bake)
 * Write:  PATCH /api/config             { key: value, ... } — validate, persist, push to interested peers
 *         POST  /api/config/:key/push   re-push current value (force)
 *         POST  /api/config/:key/reset  drop override → registry default
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import { ConfigStore, type EffectiveEntry, type ValidationError } from './store.js';

function isError(r: EffectiveEntry | ValidationError): r is ValidationError {
  return (r as ValidationError).error != null;
}

export function configModule(sharedStore?: ConfigStore): StationModule {
  // main.ts may pass a shared store so other modules (the brain) read
  // effective values in-process without a second sqlite handle.
  const store = sharedStore ?? new ConfigStore();
  let bus: Bus;
  /** peerId → set of keys that peer registered interest in. */
  const interest = new Map<string, Set<string>>();

  /** Send one entry to a specific peer (directed). */
  function sendEntry(peerId: string, kind: 'snapshot' | 'changed', e: EffectiveEntry): void {
    bus.publish({
      topic: 'config', kind,
      payload: { key: e.key, type: e.type, value: e.value, lastUpdated: e.lastUpdated },
      source: 'station', to: peerId,
    });
  }

  /** Push a changed key to every peer that registered interest in it. */
  function pushToInterested(e: EffectiveEntry): void {
    for (const [peerId, keys] of interest) {
      if (keys.has(e.key)) sendEntry(peerId, 'changed', e);
    }
  }

  /** Which currently-connected peers are interested in a key (for the UI). */
  function interestedIn(key: string): string[] {
    return [...interest].filter(([, keys]) => keys.has(key)).map(([id]) => id);
  }

  return {
    name: 'config',
    topic: 'config',
    description: 'central config: persistent, versioned, per-peer interest push',

    init(b) {
      bus = b;

      // A peer announces its interest set → record it + send a directed snapshot
      // of exactly those keys. (kind 'interest', payload { keys: string[] }.)
      bus.on('config', (msg) => {
        if (msg.kind !== 'interest' || msg.source === 'station') return;
        const keys = (msg.payload as { keys?: unknown })?.keys;
        if (!Array.isArray(keys)) return;
        const set = new Set(keys.filter((k): k is string => typeof k === 'string'));
        interest.set(msg.source, set);
        for (const e of store.list(set)) sendEntry(msg.source, 'snapshot', e);
      });

      bus.on('station', (msg) => {
        // Peer left → forget its interest so the UI/roster stays accurate.
        if (msg.kind === 'peer-left') {
          const id = (msg.payload as { id?: string })?.id;
          if (id) interest.delete(id);
        }
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/' && req.method === 'GET') {
        // attach the live interested-peer list to each entry for the console.
        const entries = store.list().map((e) => ({ ...e, interested: interestedIn(e.key) }));
        json(res, 200, { entries });
        return true;
      }

      if (subPath === '/export' && req.method === 'GET') {
        json(res, 200, store.export());
        return true;
      }

      if (subPath === '/' && (req.method === 'PATCH' || req.method === 'POST')) {
        const delta = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const applied: EffectiveEntry[] = [];
        const errors: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(delta)) {
          const r = store.set(key, value);
          if (isError(r)) errors[key] = r.issues ?? r.error;
          else { applied.push(r); pushToInterested(r); }
        }
        const code = Object.keys(errors).length && !applied.length ? 400 : 200;
        json(res, code, { applied, errors });
        return true;
      }

      const pushM = subPath.match(/^\/([^/]+)\/push$/);
      if (pushM && req.method === 'POST') {
        const e = store.get(decodeURIComponent(pushM[1]!));
        if (!e) { json(res, 404, { error: 'unknown key' }); return true; }
        pushToInterested(e);
        json(res, 200, { pushed: e });
        return true;
      }

      const resetM = subPath.match(/^\/([^/]+)\/reset$/);
      if (resetM && req.method === 'POST') {
        const r = store.reset(decodeURIComponent(resetM[1]!));
        if (isError(r)) { json(res, 404, r); return true; }
        pushToInterested(r);
        json(res, 200, { reset: r });
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
