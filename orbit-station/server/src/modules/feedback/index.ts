/**
 * Feedback module — captures a full debugging dump of a dock session as a
 * markdown file under `.data/feedback/`, for offline review.
 *
 * Triggers (all funnel into one captureFeedback path):
 *   - app button:   phone publishes { topic:'agent', kind:'feedback', payload }
 *   - brain tool:   the record_feedback tool calls the exported capture fn
 *   - api:          POST /api/feedback/
 *
 *   GET    /api/feedback/         list (frontmatter projection, newest first)
 *   GET    /api/feedback/:id      full markdown (+ parsed meta)
 *   POST   /api/feedback/         capture now { dock, sessionId?, reason?, detail? }
 *   DELETE /api/feedback/:id      remove one
 */

import type { IncomingMessage } from 'node:http';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { buildFeedback, type FeedbackWiring } from './bundler.js';
import { FeedbackStore } from './store.js';
import type { FeedbackRequest, FeedbackSource } from './types.js';

export interface FeedbackModuleWiring extends FeedbackWiring {
  /** resolve the sender peer id → its dock (the brain's tenancy rule: dock
   *  comes from the sender's hello, never the payload). */
  dockOf: (peerId: string) => string | undefined;
}

/** The capture entry point other modules call (the brain's record_feedback tool
 *  binds to this). Exported via a ref set at module init. */
export interface FeedbackCaptureApi {
  capture(req: FeedbackRequest): Promise<{ id: string; file: string }>;
}
const captureRef: { current?: FeedbackCaptureApi } = {};
/** The live capture API (set when the feedback module inits). */
export function getFeedbackCapture(): FeedbackCaptureApi | undefined {
  return captureRef.current;
}

export function feedbackModule(w: FeedbackModuleWiring): StationModule {
  const store = new FeedbackStore();

  async function capture(req: FeedbackRequest): Promise<{ id: string; file: string }> {
    const { id, key, markdown } = await buildFeedback(req, w);
    const file = store.write(key, markdown);
    console.log(`[feedback] captured ${id} (${req.source}) dock=${req.dock} session=${req.sessionId ?? 'open'} → ${file}`);
    return { id, file };
  }
  captureRef.current = { capture };

  return {
    name: 'feedback',
    topic: 'feedback',
    description: 'session feedback capture — full debugging dump per flag, MD on disk',

    init(bus: Bus) {
      // App-button path: the phone publishes a feedback frame on the `agent`
      // topic. Resolve the dock from the SENDER (never the payload), then bundle.
      bus.on('agent', (msg) => {
        if (msg.source === 'station' || msg.kind !== 'feedback') return;
        const dock = w.dockOf(msg.source);
        if (!dock) return;
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        void capture({
          dock,
          source: 'app-button',
          reason: typeof p.reason === 'string' ? p.reason : undefined,
          detail: typeof p.detail === 'string' ? p.detail : undefined,
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          clientContext: p.clientContext,
        }).catch((err) => console.error(`[feedback] ${dock}: capture crashed`, err));
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/' && req.method === 'GET') {
        json(res, 200, store.list());
        return true;
      }

      if (subPath === '/' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as Partial<FeedbackRequest>;
        if (!body.dock) {
          json(res, 400, { error: 'dock is required' });
          return true;
        }
        const source: FeedbackSource = body.source === 'brain-tool' || body.source === 'app-button' ? body.source : 'api';
        const out = await capture({
          dock: body.dock,
          sessionId: body.sessionId,
          source,
          reason: body.reason,
          detail: body.detail,
          turnId: body.turnId,
          clientContext: body.clientContext,
        });
        json(res, 201, out);
        return true;
      }

      const m = subPath.match(/^\/(.+)$/);
      if (m && req.method === 'GET') {
        const item = store.get(decodeURIComponent(m[1]!));
        if (!item) { json(res, 404, { error: 'no such feedback' }); return true; }
        json(res, 200, item);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
