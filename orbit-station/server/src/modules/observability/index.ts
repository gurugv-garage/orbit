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
 *   - GET /api/observability/requests/:sessionId/:turnId/:stepIndex
 *         the exact request that LLM step sent (systemPrompt+messages+tools)
 *
 * Live: every ingested event is re-published on the bus (topic 'obs', kind
 * 'event') so the browser UI's WS subscription streams it in real time, and so
 * observability re-publishes the agent stream for the live UI.
 */

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { healthSummary } from './health.js';
import { ObsStore } from './store.js';
import { convEventLog, setConvEventPublisher } from './conv-events.js';
import { renderIncidentMarkdown } from './incident.js';
import type { AgentEventDto, SessionEnrichment, SessionRecord } from './types.js';

/** Access to the obs store for other modules. Observability is the source of
 *  truth for per-session context: read the enriched Session/Turn/Step tree, and
 *  WRITE enrichment (provenance/config/models/perception) onto a session. The
 *  brain enriches on turn end; the feedback bundler reads the result. */
export interface ObsAccess {
  get(sessionId: string): SessionRecord | undefined;
  /** attach/refresh per-session enrichment (station-side context). */
  enrich(sessionId: string, source: string, patch: Partial<SessionEnrichment>): void;
  /** Feed one synthetic agent event into the store (+ live fan-out). Used by
   *  non-brain LLM callers (e.g. perception's Gemini calls) to record their
   *  spend as a Turn so it rolls up in the Cost tab. `source` is the owning dock. */
  ingest(ev: AgentEventDto, source: string): void;
  /** Record the exact request one LLM step sent (JSON: systemPrompt + messages
   *  + tool names). Stored gzipped in a byte-budget ring, read back via
   *  GET /api/observability/requests/:sessionId/:turnId/:stepIndex. */
  recordRequest(sessionId: string, turnId: string, stepIndex: number, json: string): void;
}
const obsRef: { current?: ObsAccess } = {};
/** The live obs store reader/writer (set when the observability module inits). */
export function getObsAccess(): ObsAccess | undefined {
  return obsRef.current;
}

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
      // Conversation-timeline events (conv-events.ts): emitters across perception/
      // brain/session record directly; here we wire the live fan-out so the
      // browser timeline streams them as they land (same topic as agent events).
      setConvEventPublisher((ev) => {
        bus.publish({ topic: 'obs', kind: 'conv-event', payload: ev, source: 'station' });
      });
      // Publish the cross-module access only once the bus is live (the exposed
      // `ingest` re-publishes onto it), so a caller can never hit an undefined bus.
      obsRef.current = {
        get: (id) => store.get(id),
        enrich: (id, source, patch) => { store.enrich(id, source, patch); },
        ingest: (ev, source) => { ingest(ev, source); },
        recordRequest: (id, turnId, stepIndex, json) => { store.putRequest(id, turnId, stepIndex, json); },
      };
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
      // GET /search-shots?dock=&from=&to= — list a search's judged-view shots
      // (filenames carry <dock>-<epochMs>-<tag>.jpg) so the trace can render
      // the WHOLE sweep, found or not, without paths riding the tool result.
      if (subPath === '/search-shots' && req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        const dock = u.searchParams.get('dock') ?? '';
        const from = Number(u.searchParams.get('from') ?? 0);
        const to = Number(u.searchParams.get('to') ?? Date.now());
        let files: string[] = [];
        try { files = readdirSync('.data/search'); } catch { /* none yet */ }
        const shots = files.map((f) => {
          const m = /^(.+)-(\d{13})-(.+)\.jpg$/.exec(f);
          return m ? { f, dock: m[1]!, ts: Number(m[2]), tag: m[3]! } : undefined;
        }).filter((s): s is NonNullable<typeof s> => !!s && (dock === '' || s.dock === dock) && s.ts >= from && s.ts <= to)
          .sort((a, b) => a.ts - b.ts)
          .map(({ f, ts, tag }) => ({ f, ts, tag }));
        json(res, 200, { shots });
        return true;
      }

      // GET /search-shot?f=<basename.jpg> — serve a visual_search found-view
      // snapshot (.data/search) so the trace can SHOW what "gotcha" saw.
      // Basename-only: no separators/traversal reach the filesystem.
      if (subPath === '/search-shot' && req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        const f = u.searchParams.get('f') ?? '';
        if (!/^[a-zA-Z0-9._-]+\.jpg$/.test(f)) { json(res, 400, { error: 'bad shot name' }); return true; }
        const file = `.data/search/${f}`;
        if (!existsSync(file)) { json(res, 404, { error: 'no such shot' }); return true; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
        createReadStream(file).pipe(res);
        return true;
      }

      // ── conversation timeline (conv_events) ────────────────────────────────
      // GET /conv-events?dock&from&to&limit&lanes=phone,brain — the durable
      // cross-component event stream (see conv-events.ts). Feeds the Timeline UI.
      if (subPath === '/conv-events' && req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        json(res, 200, {
          events: convEventLog().query({
            dock: u.searchParams.get('dock') ?? undefined,
            from: num(u, 'from'), to: num(u, 'to'), limit: num(u, 'limit'),
            lanes: u.searchParams.get('lanes')?.split(',').filter(Boolean),
          }),
        });
        return true;
      }

      // ── incident bundle ────────────────────────────────────────────────────
      // GET /incident?dock&from&to[&format=md] — ONE self-contained bundle for a
      // time window: every conv event, every turn (full Session/Turn/Step detail),
      // the perception snapshots, on one timeline. The paste-to-an-LLM debugging
      // artifact: "here is exactly what happened on every component".
      if (subPath === '/incident' && req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        const dock = u.searchParams.get('dock') ?? undefined;
        const to = num(u, 'to') ?? Date.now();
        const from = num(u, 'from') ?? to - 15 * 60_000;
        const events = convEventLog().query({ dock, from, to, limit: 10_000 });
        const turns = store.turnsInWindow(from, to)
          .filter((t) => !dock || t.source === dock)
          .map(({ turn, source }) => ({ ...turn, source }));
        // snapshots come from perception — imported lazily so observability never
        // depends on perception at module load (perception already imports obs).
        let snapshots: unknown[] = [];
        try {
          const { getSnapshotsApi } = await import('../perception/index.js');
          snapshots = getSnapshotsApi()?.inWindow(new Date(from).toISOString(), new Date(to).toISOString(), dock) ?? [];
        } catch { /* perception absent (tests) — bundle without snapshots */ }
        const bundle = { dock: dock ?? 'all', from, to, generatedAt: Date.now(), events, turns, snapshots };
        if (u.searchParams.get('format') === 'md') {
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
          res.end(renderIncidentMarkdown(bundle));
        } else {
          json(res, 200, bundle);
        }
        return true;
      }

      // GET /req-image?f=<sha1-20>.jpg — a frame from a recorded LLM request
      // (content-addressed; one file per unique frame across all requests).
      if (subPath === '/req-image' && req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        const f = u.searchParams.get('f') ?? '';
        if (!/^[a-f0-9]{20}\.jpg$/.test(f)) { json(res, 400, { error: 'bad image ref' }); return true; }
        const file = `.data/req-images/${f}`;
        if (!existsSync(file)) { json(res, 404, { error: 'no such request image (evicted?)' }); return true; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
        createReadStream(file).pipe(res);
        return true;
      }

      // GET /turn-image?f=<dock>/<turnId>.jpg — the input frame a vision turn's
      // model actually saw (saved by the session; the request ring strips bytes).
      if (subPath === '/turn-image' && req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        const f = u.searchParams.get('f') ?? '';
        if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\.jpg$/.test(f)) { json(res, 400, { error: 'bad image ref' }); return true; }
        const file = `.data/turn-images/${f}`;
        if (!existsSync(file)) { json(res, 404, { error: 'no such turn image' }); return true; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
        createReadStream(file).pipe(res);
        return true;
      }

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
        // (kept a bare array — the console chart consumes it directly; the
        // summary endpoint carries `currency`, and the numbers are USD per the
        // CostSeriesPoint doc. Don't reshape without updating web/Cost.tsx.)
        json(res, 200, store.costSeries(from, to, groupBy));
        return true;
      }

      // the exact request an LLM step sent (recorded at the streamFn seam).
      const rq = subPath.match(/^\/requests\/([^/]+)\/([^/]+)\/(\d+)$/);
      if (rq && req.method === 'GET') {
        const body = store.getRequest(decodeURIComponent(rq[1]!), decodeURIComponent(rq[2]!), Number(rq[3]));
        if (body == null) {
          json(res, 404, { error: 'request not recorded (or evicted from the ring)' });
          return true;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body); // already a JSON document — pass through verbatim
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

/** A numeric query param, or undefined when absent/invalid. */
function num(u: URL, key: string): number | undefined {
  const v = Number(u.searchParams.get(key));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Parse ?from&to (epoch ms); default to the last 7 days. */
function costWindow(u: URL): { from: number; to: number } {
  const now = Date.now();
  const to = Number(u.searchParams.get('to')) || now;
  const from = Number(u.searchParams.get('from')) || to - 7 * 24 * 3600_000;
  return { from: Math.min(from, to), to };
}

function costGroupBy(raw: string | null): CostGroupBy {
  return raw === 'source' || raw === 'kind' || raw === 'model' || raw === 'day' || raw === 'usecase'
    ? raw : 'source';
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
