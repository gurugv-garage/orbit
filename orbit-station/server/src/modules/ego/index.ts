/**
 * Ego module — the per-dock ego document (docs/decision-traces/ego.md), its introspection,
 * and its trace. Slice 1: manual trigger + read surface (console Ego tab). The conductor
 * idle auto-trigger is slice 2.
 *
 * REST (/api/ego):
 *   GET  /:dock              → { dock, ego, exists }           the current ego document
 *   GET  /:dock/trace        → { dock, entries:[{name,ts}] }   past introspections (newest first)
 *   GET  /:dock/trace/:name  → { name, ego }                   one past ego snapshot
 *   POST /:dock/introspect   → { ok, fresh, snapshotted, trigger }  run one introspection now
 */
import { readFileSync, existsSync } from 'node:fs';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { loadEgo, loadTrace } from './ego-store.js';
import { introspect } from './introspect.js';

const LAST_SUMMARY_FILE = '.data/perception/last-summary.json';

/** "Recent experience" for a dock = the perception rolling picture (what it's perceived
 *  lately). Read from the persisted file so the ego module stays decoupled from perception.
 *  (Slice 2 can enrich this with recent brain turns.) */
function recentExperience(dock: string): string {
  try {
    if (!existsSync(LAST_SUMMARY_FILE)) return '';
    const all = JSON.parse(readFileSync(LAST_SUMMARY_FILE, 'utf8')) as Record<string, { text?: string; window?: { from?: string; to?: string } }>;
    const v = all[dock];
    if (!v?.text) return '';
    const w = v.window;
    return `Latest perception${w?.from ? ` (${w.from.slice(11, 19)}–${(w.to ?? '').slice(11, 19)})` : ''}:\n${v.text}`;
  } catch {
    return '';
  }
}

/** Run one introspection for a dock, assembling its recent experience — the shared entry
 *  the REST handler and the conductor's idle heartbeat both call. */
export function introspectDock(dock: string, trigger: string) {
  return introspect(dock, recentExperience(dock), { trigger });
}

export function egoModule(): StationModule {
  return {
    name: 'ego',
    topic: 'ego',
    description: 'per-dock ego document (identity + story), introspection, and its trace',
    init(_bus: Bus) { /* slice 1 is REST-only; the conductor auto-trigger lands in slice 2 */ },
    async route(ctx: RouteContext): Promise<boolean> {
      const { req, res, subPath } = ctx;

      // GET /:dock/trace/:name — one past ego snapshot
      let m = subPath.match(/^\/([^/]+)\/trace\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const [, dock, name] = m;
        const entry = loadTrace(dock!, 500).find((e) => e.name === name);
        json(res, entry ? 200 : 404, entry ? { name, ego: entry.text } : { error: 'no such snapshot' });
        return true;
      }

      // GET /:dock/trace — the list of past introspections (newest first)
      m = subPath.match(/^\/([^/]+)\/trace$/);
      if (m && req.method === 'GET') {
        const [, dock] = m;
        const entries = loadTrace(dock!, 200).reverse().map((e) => ({ name: e.name, ts: e.name }));
        json(res, 200, { dock, entries });
        return true;
      }

      // POST /:dock/introspect — run one introspection now (manual trigger)
      m = subPath.match(/^\/([^/]+)\/introspect$/);
      if (m && req.method === 'POST') {
        const [, dock] = m;
        try {
          const r = await introspectDock(dock!, 'manual');
          json(res, 200, { ok: true, dock, fresh: r.fresh, snapshotted: r.snapshotted, trigger: r.trigger, ego: r.ego });
        } catch (e) {
          json(res, 500, { ok: false, error: String((e as Error).message || e) });
        }
        return true;
      }

      // GET /:dock — the current ego
      m = subPath.match(/^\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const [, dock] = m;
        const { text, fresh } = loadEgo(dock!);
        json(res, 200, { dock, ego: text, exists: !fresh });
        return true;
      }

      return false;
    },
  };
}
