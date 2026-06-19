/**
 * Observability module.
 *
 * Ingest paths (both supported, same shape):
 *   - HTTP  POST /api/observability/events   (one AgentEventDto or an array)
 *   - WS    publish { topic:'obs', kind:'event', payload: AgentEventDto }
 *
 * Read paths:
 *   - GET /api/observability/sessions            list (summaries)
 *   - GET /api/observability/sessions/:id        full Session/Turn/Step tree
 *   - GET /api/observability/cost/summary        LLM spend totals + breakdown
 *   - GET /api/observability/cost/series         per-day spend (stacked chart)
 *
 * Live: every ingested event is re-published on the bus (topic 'obs', kind
 * 'event') so the browser UI's WS subscription streams it in real time, and so
 * observability re-publishes the agent stream for the live UI.
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { healthSummary } from './health.js';
import { ObsStore } from './store.js';
import type { AgentEventDto } from './types.js';

export function observabilityModule(): StationModule {
  const store = new ObsStore();
  let bus: Bus;

  function ingest(ev: AgentEventDto, source: string): void {
    store.ingest(ev, source);
    // re-publish for live UI. MUST be source 'station' so our own bus
    // handler (below) skips re-ingesting it — otherwise every HTTP event lands
    // in the store twice (the original ingest above + this echo). WS-arrived
    // events are already published by the hub, so they only need this for HTTP.
    bus.publish({ topic: 'obs', kind: 'event', payload: ev, source: 'station' });
  }

  return {
    name: 'observability',
    topic: 'obs',
    description: 'agent-core Session/Turn/Step trace ingest + live stream',

    init(b) {
      bus = b;
      // WS ingest: peers publishing obs events feed the store too.
      bus.on('obs', (msg) => {
        if (msg.source === 'station') return; // our own re-publish
        if (msg.kind === 'event') {
          const ev = msg.payload as AgentEventDto;
          // a task self-declares its owning dock as `source` (its WS peer id is
          // the task, not the dock — see AgentEventDto.source); honor it.
          store.ingest(ev, ev.source ?? msg.source);
        }
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/events' && req.method === 'POST') {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as AgentEventDto | AgentEventDto[];
        const events = Array.isArray(parsed) ? parsed : [parsed];
        const source = (req.headers['x-orbit-source'] as string) ?? 'http';
        events.forEach((ev) => ingest(ev, source));
        json(res, 202, { accepted: events.length });
        return true;
      }

      if (subPath === '/sessions' && req.method === 'GET') {
        json(res, 200, store.list());
        return true;
      }

      // UX-health summary over the last N turns (default 100): latency
      // percentiles + reliability counters. The regression tripwire for
      // "snappy and reliable" — see health.ts for what each metric catches.
      if (subPath === '/health' && req.method === 'GET') {
        const url = new URL(req.url ?? '', 'http://x');
        const window = Math.max(1, Math.min(2000, Number(url.searchParams.get('window')) || 100));
        json(res, 200, healthSummary(store.recentTurns(window)));
        return true;
      }

      // Cost rollups (the Cost tab). Window defaults to the last 7 days.
      // groupBy: source (dock) | kind (user vs task) | model | day.
      if (subPath === '/cost/summary' && req.method === 'GET') {
        const u = new URL(req.url ?? '', 'http://x');
        const { from, to } = costWindow(u);
        const groupBy = costGroupBy(u.searchParams.get('groupBy'));
        json(res, 200, store.costRollup(from, to, groupBy));
        return true;
      }
      if (subPath === '/cost/series' && req.method === 'GET') {
        const u = new URL(req.url ?? '', 'http://x');
        const { from, to } = costWindow(u);
        const g = costGroupBy(u.searchParams.get('groupBy'));
        // series only splits by the dimensions a stacked chart shows.
        const groupBy = g === 'day' ? 'kind' : g;
        json(res, 200, store.costSeries(from, to, groupBy));
        return true;
      }

      const m = subPath.match(/^\/sessions\/(.+)$/);
      if (m && req.method === 'GET') {
        const s = store.get(decodeURIComponent(m[1]!));
        if (!s) {
          json(res, 404, { error: 'no such session' });
          return true;
        }
        json(res, 200, s);
        return true;
      }
      if (m && req.method === 'DELETE') {
        const ok = store.delete(decodeURIComponent(m[1]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }

      return false;
    },
  };
}

import type { CostGroupBy } from './types.js';

/** Parse ?from&to (epoch ms); default to the last 7 days. */
function costWindow(u: URL): { from: number; to: number } {
  const now = Date.now();
  const to = Number(u.searchParams.get('to')) || now;
  const from = Number(u.searchParams.get('from')) || to - 7 * 24 * 3600_000;
  return { from: Math.min(from, to), to };
}

function costGroupBy(raw: string | null): CostGroupBy {
  return raw === 'source' || raw === 'kind' || raw === 'model' || raw === 'day' ? raw : 'source';
}

import type { IncomingMessage } from 'node:http';
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
