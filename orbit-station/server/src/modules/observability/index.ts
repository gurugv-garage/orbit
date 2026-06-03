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
 *
 * Live: every ingested event is re-published on the bus (topic 'obs', kind
 * 'event') so the browser UI's WS subscription streams it in real time, and so
 * `mind` can watch the agent stream.
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { ObsStore } from './store.js';
import type { AgentEventDto } from './types.js';

export function observabilityModule(): StationModule {
  const store = new ObsStore();
  let bus: Bus;

  function ingest(ev: AgentEventDto, source: string): void {
    store.ingest(ev, source);
    // re-publish for live UI + mind. MUST be source 'station' so our own bus
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
        if (msg.kind === 'event') store.ingest(msg.payload as AgentEventDto, msg.source);
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

      return false;
    },
  };
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
