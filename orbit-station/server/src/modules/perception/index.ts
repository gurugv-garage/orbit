/**
 * Perception module — owns the `perception` topic, the per-dock world-state, and
 * the processor registry's contents. The ProcessingHub itself is built in main.ts
 * (it must be the SFU's media tap, wired before the perception module inits); this
 * module registers processors onto it and aggregates their results into
 * PerceptionState, exposed over REST + pushed live on the `perception` topic.
 *
 *   GET /api/perception          all docks' world states
 *   GET /api/perception/:dockId  one dock's world state
 *   POST /api/perception/result  worker/sidecar processors post results here (Phase 2)
 *
 * The dock subscribes to `perception` (directed results) and re-grounds its agent;
 * the browser console subscribes (undirected `state`) and renders a panel.
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import { fileURLToPath } from 'node:url';
import type { ProcessingHub } from './hub.js';
import { PerceptionState } from './state.js';
import { presenceProcessor } from './processors/presence.js';
import { faceRecognitionProcessor } from './processors/face-recognition.js';
import { Gallery } from './face/gallery.js';
import { describeFace } from './face/recognizer.js';

/** A base64 JPEG (the dock's on-device camera frame) → its face descriptor. */
async function describeBase64(b64: string): Promise<number[] | null> {
  try { return await describeFace(Buffer.from(b64, 'base64')); } catch { return null; }
}
// MATCH: confident "this is X". TENTATIVE: the "might be X" hedge band.
// 0.78 was far too loose — different people sit ~0.7-0.9 apart in this 320px
// embedding space, so a genuinely NEW face kept getting scooped up as "might be
// <some enrolled person>". Tightened so an unknown face reads as unknown.
const MATCH = 0.6, TENTATIVE = 0.66;
import { makeResult, type PerceptionResult } from './result.js';

// Gallery persists next to the server's data (alongside the db). One file.
const GALLERY_PATH = fileURLToPath(new URL('../../../data/face-gallery.json', import.meta.url));

export function perceptionModule(getHub: () => ProcessingHub): StationModule {
  let state: PerceptionState;
  let bus: Bus;
  const gallery = new Gallery(GALLERY_PATH);
  const face = faceRecognitionProcessor(gallery);

  /** Publish a result directed to its dock + an undirected copy (state/console). */
  function fanResult(r: PerceptionResult): void {
    bus.publish({ topic: 'perception', kind: r.kind, payload: r, source: 'station', to: r.dockId });
    bus.publish({ topic: 'perception', kind: r.kind, payload: r, source: 'station' });
  }

  return {
    name: 'perception',
    topic: 'perception',
    description: 'stream-processing results + per-dock world-state (presence, identity, …)',

    init(b: Bus) {
      bus = b;
      state = new PerceptionState(bus);
      const hub = getHub();
      // Always-on processors. More land here as phases progress (audio, …).
      hub.register(presenceProcessor());
      hub.register(face);

      // Agent-driven enrollment over the WS: the dock's `remember_face` tool
      // publishes `perception`/`enroll-request {name}`; we enroll the face it's
      // currently streaming (streamId = the app's peer id = msg.source) and reply
      // `enroll-result` directed back to that dock.
      bus.on('perception', (msg) => {
        if (msg.source === 'station') return;
        const p = msg.payload as { name?: string; reqId?: string; photo?: string } | null;
        // The dock sends `photo` = its CLEAN on-device camera JPEG (base64). We
        // recognize/enroll from THAT directly — no dependency on the live WebRTC
        // stream (which decodes lossily and drops). This is the on-demand path.
        if (msg.kind === 'enroll-request') {
          const name = p?.name?.trim();
          if (!name || !p?.photo) {
            bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { ok: false, reason: name ? 'no photo' : 'no name' }, source: 'station', to: msg.source });
            return;
          }
          void describeBase64(p.photo).then((d) => {
            const ok = !!d;
            if (d) gallery.enroll(name, d, p.photo);
            bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { name, ok, reason: ok ? undefined : 'no face detected' }, source: 'station', to: msg.source });
          });
        } else if (msg.kind === 'recognize-request') {
          const reqId = p?.reqId;
          void describeBase64(p?.photo ?? '').then((d) => {
            let out: { name: string | null; tentative: string | null; confidence: number; noFace: boolean };
            if (!d) out = { name: null, tentative: null, confidence: 0, noFace: true };
            else {
              const m = gallery.match(d, MATCH);
              if (m) out = { name: m.name, tentative: null, confidence: Math.max(0, 1 - m.distance), noFace: false };
              else {
                const t = gallery.match(d, TENTATIVE);
                out = { name: null, tentative: t?.name ?? null, confidence: t ? Math.max(0, 1 - t.distance) : 0, noFace: false };
              }
            }
            bus.publish({ topic: 'perception', kind: 'recognize-result', payload: { reqId, ...out }, source: 'station', to: msg.source });
          });
        } else if (msg.kind === 'confirm-request') {
          // confirm_face: user said "yes I'm X" → append this photo as more data.
          const name = p?.name?.trim();
          if (name && p?.photo) void describeBase64(p.photo).then((d) => { if (d) gallery.enroll(name, d, undefined, true); });
        } else if (msg.kind === 'forget-request') {
          // forget_face: "that's not me" → drop the wrong association.
          const name = (msg.payload as { name?: string } | null)?.name?.trim();
          if (name) void face.forgetCurrent(msg.source, name);
        }
      });

      // Generic reconnect snapshot: when a dock (re)joins, push it its current
      // world-state so the agent re-grounds immediately (identity is one field).
      bus.on('station', (msg) => {
        if (msg.kind !== 'peer-joined') return;
        const p = msg.payload as { role?: string; id?: string; dock?: string } | null;
        if (p?.role !== 'app' || !p.dock) return;
        const ws = state.get(p.dock);
        if (ws) bus.publish({ topic: 'perception', kind: 'snapshot', payload: ws, source: 'station', to: p.id });
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (req.method === 'GET' && subPath === '/') {
        json(res, 200, state.all());
        return true;
      }
      // DEBUG: dump the current decoded frame the face processor sees, to inspect
      // what's actually being recognized.  GET /api/perception/frame/:streamId
      if (req.method === 'GET' && subPath.startsWith('/frame/')) {
        const streamId = decodeURIComponent(subPath.slice('/frame/'.length));
        const buf = face.currentFrame(streamId);
        if (!buf) { json(res, 404, { error: 'no frame' }); return true; }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(buf);
        return true;
      }
      // Gallery: list enrolled people / remove one.
      if (req.method === 'GET' && subPath === '/gallery') {
        // names (back-compat) + people [{name, photo}] for the console thumbnails.
        json(res, 200, { names: gallery.names(), people: gallery.people() });
        return true;
      }
      // Enroll the face currently on screen for a dock: { streamId, name }.
      if (req.method === 'POST' && subPath === '/enroll') {
        const body = JSON.parse(await readBody(req)) as { streamId?: string; name?: string };
        if (!body.streamId || !body.name) {
          json(res, 400, { error: 'enroll needs streamId + name' });
          return true;
        }
        const result = await face.enrollCurrent(body.streamId, body.name.trim());
        json(res, result.ok ? 200 : 409, result);
        return true;
      }
      if (req.method === 'POST' && subPath === '/gallery/remove') {
        const body = JSON.parse(await readBody(req)) as { name?: string };
        const removed = body.name ? gallery.remove(body.name) : false;
        json(res, 200, { removed });
        return true;
      }
      if (req.method === 'GET' && subPath.length > 1) {
        const dockId = decodeURIComponent(subPath.slice(1));
        json(res, 200, state.get(dockId) ?? { error: 'unknown dock', dockId });
        return true;
      }
      // Worker/sidecar processors POST results here; we fold + fan them like any
      // in-process result (directed to the dock + broadcast for the console/state).
      if (req.method === 'POST' && subPath === '/result') {
        const body = JSON.parse(await readBody(req)) as Partial<PerceptionResult>;
        if (!body.kind || !body.dockId || !body.streamId) {
          json(res, 400, { error: 'result needs kind, dockId, streamId' });
          return true;
        }
        const r = makeResult({
          kind: body.kind, dockId: body.dockId, streamId: body.streamId,
          payload: body.payload ?? {}, confidence: body.confidence,
          source: body.source ?? 'external', ts: body.ts,
        });
        // Direct to the dock (agent re-grounds) + broadcast (state folds it in).
        fanResult(r);
        json(res, 200, { ok: true });
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
