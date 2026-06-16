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
import { Observations } from './observations.js';
import { presenceProcessor } from './processors/presence.js';
import { faceRecognitionProcessor } from './processors/face-recognition.js';
import { visionWatchProcessor } from './processors/vision-watch.js';
import { sttWatchProcessor } from './processors/stt-watch.js';
import { temporalWatchProcessor } from './processors/temporal-watch.js';
import { setVisionExtra, getVisionExtra, visionBase } from './vision-instruction.js';
import { setVisionConfig, getVisionConfig } from './vision-config.js';
import { Gallery } from './face/gallery.js';
import { describeFace, describeAllFaces, type DetectedFace } from './face/recognizer.js';

/** A base64 JPEG (the dock's on-device camera frame) → its face descriptor. */
async function describeBase64(b64: string): Promise<number[] | null> {
  try { return await describeFace(Buffer.from(b64, 'base64')); } catch { return null; }
}
/** All faces in a base64 JPEG, left-to-right. Empty on decode/parse failure. */
async function describeAllBase64(b64: string): Promise<DetectedFace[]> {
  try { return await describeAllFaces(Buffer.from(b64, 'base64')); } catch { return []; }
}
/** A horizontal position word from a normalized x (0=left … 1=right). */
function sideOf(cx: number): 'left' | 'center' | 'right' {
  return cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
}
import { makeResult, type PerceptionResult } from './result.js';
import { classifyDistance, TENTATIVE_THRESHOLD } from './face/gallery.js';

// Gallery persists next to the server's data (alongside the db). One file.
const GALLERY_PATH = fileURLToPath(new URL('../../../data/face-gallery.json', import.meta.url));

/** One recognized (or unrecognized) face, as the brain's tools consume it. */
export interface RecognizedPerson {
  name: string | null;
  tentative: string | null;
  confidence: number;
  side: 'left' | 'center' | 'right';
}
export interface RecognizeOut {
  name: string | null;
  tentative: string | null;
  confidence: number;
  noFace: boolean;
  people: RecognizedPerson[];
}

/**
 * In-process face API for the server brain's tools (remember/recollect/
 * confirm/forget_face) — the same operations the WS request/result flow
 * serves, minus the round-trip. Photo-first (the turn-request's attached
 * camera JPEG); falls back to the dock's live SFU frame via `streamId`.
 */
export interface FaceToolsApi {
  enroll(opts: { name: string; photo?: string; streamId?: string }): Promise<{ ok: boolean; reason?: string }>;
  recognize(opts: { photo?: string; streamId?: string }): Promise<RecognizeOut>;
  confirm(opts: { name: string; photo?: string; streamId?: string }): Promise<{ ok: boolean }>;
  forget(opts: { name: string; streamId?: string }): Promise<{ ok: boolean }>;
  /** The latest decoded frame of a live SFU stream as base64 JPEG — the
   *  brain's vision source when the phone didn't attach a photo (the video
   *  is already flowing; vision turns need no extra upload). */
  frame(streamId: string): string | undefined;
}

const faceToolsRef: { current?: FaceToolsApi } = {};
/** The live FaceToolsApi (set when the perception module inits). */
export function getFaceTools(): FaceToolsApi | undefined {
  return faceToolsRef.current;
}

export function perceptionModule(getHub: () => ProcessingHub): StationModule {
  let state: PerceptionState;
  let observations: Observations;
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
      observations = new Observations(bus); // rolling tier-1 log (vision + stt)
      const hub = getHub();
      // Always-on processors. More land here as phases progress (audio, …).
      hub.register(presenceProcessor());
      hub.register(face);
      hub.register(sttWatchProcessor());      // whisper utterance transcript (sidecar)
      hub.register(temporalWatchProcessor()); // qwen multi-frame: scene + action (sidecar)
      // NB: per-frame vision-watch (moondream/md3) is intentionally NOT registered —
      // qwen temporal covers both scene and action in one pass, so we run ONE vision
      // model (~3GB) instead of stacking moondream+md3+qwen (~10GB → swap). Re-enable
      // visionWatchProcessor() if you want a fast 1Hz per-frame pass alongside.

      // In-process face API for the server brain (docs/SERVER-BRAIN-IMPL.md §3.1):
      // the same operations the WS request/result flow below serves, exposed as
      // function calls so the brain's tools skip the round-trip.
      faceToolsRef.current = {
        async enroll({ name, photo, streamId }) {
          const n = name.trim();
          if (!n) return { ok: false, reason: 'no name' };
          if (photo) {
            const d = await describeBase64(photo);
            if (!d) return { ok: false, reason: 'no face detected' };
            gallery.enroll(n, d, photo, gallery.has(n)); // append for a known name
            return { ok: true };
          }
          if (streamId) return face.enrollCurrent(streamId, n);
          return { ok: false, reason: 'no photo or stream' };
        },
        async recognize({ photo, streamId }) {
          let faces: DetectedFace[] = [];
          if (photo) {
            faces = await describeAllBase64(photo);
          } else if (streamId) {
            const buf = face.currentFrame(streamId);
            if (buf) { try { faces = await describeAllFaces(buf); } catch { faces = []; } }
          }
          const people = faces.map((f) => {
            const m = gallery.match(f.descriptor, TENTATIVE_THRESHOLD);
            const verdict = m ? classifyDistance(m.distance) : 'none';
            return {
              name: verdict === 'confident' ? m!.name : null,
              tentative: verdict === 'tentative' ? m!.name : null,
              confidence: m ? Math.max(0, 1 - m.distance) : 0,
              side: sideOf(f.cx),
            };
          });
          const confident = people.filter((x) => x.name).sort((a, b) => b.confidence - a.confidence);
          const tentatives = people.filter((x) => !x.name && x.tentative).sort((a, b) => b.confidence - a.confidence);
          const primary = confident[0] ?? tentatives[0];
          return {
            name: confident[0]?.name ?? null,
            tentative: confident[0] ? null : (tentatives[0]?.tentative ?? null),
            confidence: primary?.confidence ?? 0,
            noFace: faces.length === 0,
            people,
          };
        },
        async confirm({ name, photo, streamId }) {
          const n = name.trim();
          if (!n) return { ok: false };
          if (photo) {
            const d = await describeBase64(photo);
            if (d) { gallery.enroll(n, d, photo, true); return { ok: true }; }
            return { ok: false };
          }
          if (streamId) {
            const r = await face.enrollCurrent(streamId, n);
            return { ok: r.ok };
          }
          return { ok: false };
        },
        frame(streamId) {
          return face.currentFrame(streamId)?.toString('base64');
        },
        async forget({ name, streamId }) {
          const n = name.trim();
          if (!n) return { ok: false };
          if (streamId) { void face.forgetCurrent(streamId, n); return { ok: true }; }
          return { ok: gallery.remove(n) };
        },
      };

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
            // APPEND for a known name (another angle → recognition improves).
            // Replacing on every "my name is X" wiped a person's whole sample
            // set down to one possibly-bad frame — recognition got WORSE each
            // time someone re-introduced themselves. Full replacement is a
            // deliberate console action (REST /gallery), not a voice flow.
            if (d) gallery.enroll(name, d, p.photo, gallery.has(name));
            bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { name, ok, reason: ok ? undefined : 'no face detected' }, source: 'station', to: msg.source });
          });
        } else if (msg.kind === 'recognize-request') {
          const reqId = p?.reqId;
          void describeAllBase64(p?.photo ?? '').then((faces) => {
            // Classify EVERY face: confident name, tentative name, or unknown —
            // each tagged with its side (left/center/right) so the dock can say
            // "Guru on the left, someone I don't know on the right". The
            // confident/tentative split is [classifyDistance] — ONE definition;
            // the raw confidence rides along for display only (the dock must
            // act on the categorical fields, never re-threshold the float).
            const people = faces.map((f) => {
              const m = gallery.match(f.descriptor, TENTATIVE_THRESHOLD);
              const verdict = m ? classifyDistance(m.distance) : 'none';
              return {
                name: verdict === 'confident' ? m!.name : null,
                tentative: verdict === 'tentative' ? m!.name : null,
                confidence: m ? Math.max(0, 1 - m.distance) : 0,
                side: sideOf(f.cx),
              };
            });
            // Back-compat single fields (the dock caches one identity): pick the
            // best confident match, else the best tentative.
            const confident = people.filter((x) => x.name).sort((a, b) => b.confidence - a.confidence);
            const tentatives = people.filter((x) => !x.name && x.tentative).sort((a, b) => b.confidence - a.confidence);
            const primary = confident[0] ?? tentatives[0];
            const out = {
              name: confident[0]?.name ?? null,
              tentative: confident[0] ? null : (tentatives[0]?.tentative ?? null),
              confidence: primary?.confidence ?? 0,
              noFace: faces.length === 0,
              people, // the full per-face list (multi-person)
            };
            bus.publish({ topic: 'perception', kind: 'recognize-result', payload: { reqId, ...out }, source: 'station', to: msg.source });
          });
        } else if (msg.kind === 'confirm-request') {
          // confirm_face: user said "yes I'm X" → append this capture (descriptor
          // + its photo) as another angle, so it's visible/deletable in the console.
          const name = p?.name?.trim();
          if (name && p?.photo) void describeBase64(p.photo).then((d) => { if (d) gallery.enroll(name, d, p.photo, true); });
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
        const p = msg.payload as { caps?: string[]; id?: string; dock?: string } | null;
        // re-ground whichever component renders identity/face state (the phone
        // declares the 'face' cap) — routing by capability, not role.
        if (!p?.dock || !(p.caps ?? []).includes('face')) return;
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
      // Rolling tier-1 observations (vision + stt). GET /observations[?dock=] →
      // newest-last array. GET /observations/stream → SSE live feed.
      if (req.method === 'GET' && subPath === '/observations') {
        const dock = new URL(req.url ?? '', 'http://x').searchParams.get('dock') ?? undefined;
        json(res, 200, observations.list(dock));
        return true;
      }
      // Clear the rolling observation buffer (console "Clear" button).
      if (req.method === 'POST' && subPath === '/observations/clear') {
        observations.clear();
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'GET' && subPath === '/observations/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const unsub = observations.subscribe((o) => res.write(`data: ${JSON.stringify(o)}\n\n`));
        req.on('close', unsub);
        return true;
      }
      // Steer the vision instruction. GET → {base, extra}; POST {extra} sets it.
      if (req.method === 'GET' && subPath === '/instruction') {
        json(res, 200, { base: visionBase(), extra: getVisionExtra() });
        return true;
      }
      if (req.method === 'POST' && subPath === '/instruction') {
        const body = JSON.parse(await readBody(req)) as { extra?: string };
        setVisionExtra(body.extra ?? '');
        json(res, 200, { base: visionBase(), extra: getVisionExtra() });
        return true;
      }
      // Vision backend (moondream ↔ md3), live-switchable.
      if (req.method === 'GET' && subPath === '/vision-config') {
        json(res, 200, getVisionConfig());
        return true;
      }
      if (req.method === 'POST' && subPath === '/vision-config') {
        const body = JSON.parse(await readBody(req)) as { model?: 'moondream' | 'md3' };
        setVisionConfig(body);
        json(res, 200, getVisionConfig());
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
        // names (back-compat) + people [{name, samples:[{index, photo}]}] so the
        // console can show every enrolled capture and delete one by index.
        json(res, 200, { names: gallery.names(), people: gallery.people() });
        return true;
      }
      // Delete one enrolled capture (fingerprint+photo): { name, index }.
      // Removing the last one removes the person.
      if (req.method === 'POST' && subPath === '/gallery/sample/remove') {
        const body = JSON.parse(await readBody(req)) as { name?: string; index?: number };
        const removed = body.name != null && typeof body.index === 'number'
          ? gallery.removeSample(body.name, body.index) : false;
        json(res, 200, { removed });
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
