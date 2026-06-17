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
import { visionSnapshotProcessor } from './processors/vision-snapshot.js';
import { identitySnapshotProcessor } from './processors/identity-snapshot.js';
import { sttWatchProcessor } from './processors/stt-watch.js';
import { bodyMotionWatchProcessor, type MotionCommand } from './processors/bodymotion-watch.js';
import { SnapshotStore, isoIst, sampleEvenly } from './snapshots.js';
import { TakeStore } from './takes.js';
import { summarize } from './summarizer.js';
import { buildGrounding, type LastSummary } from './grounding.js';
import { setVisionExtra, getVisionExtra, visionBase } from './vision-instruction.js';
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
/** The dock most of these records belong to (the store mixes docks; a summarize
 *  window is normally one dock's). Empty string if there are none. */
function dominantDock(recs: { dockId: string }[]): string {
  const tally = new Map<string, number>();
  for (const r of recs) if (r.dockId) tally.set(r.dockId, (tally.get(r.dockId) ?? 0) + 1);
  let best = '', n = 0;
  for (const [d, c] of tally) if (c > n) { best = d; n = c; }
  return best;
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

/**
 * Perception GROUNDING for the brain (docs/PERCEPTION-TO-AGENT.md Decision 3.1):
 * the per-turn context block — the last summary (stamped with staleness) plus the
 * raw stream since it. Pulled synchronously when a turn is built (no Gemini on the
 * turn's critical path); the brain injects the returned string into the prompt.
 * Returns undefined when nothing has been perceived yet (a cold dock).
 */
export interface PerceptionGroundingApi {
  /** the grounding block for `dockId` right now, or undefined if there's nothing. */
  forDock(dockId: string): string | undefined;
  /**
   * FORCE a fresh summary of the live moment NOW (docs/PERCEPTION-TO-AGENT.md 3.2
   * `force_get_current`): flush the in-flight tail (open utterance + a one-shot
   * vision capture), summarize the just-closed window, cache it as the dock's last
   * summary (so grounding goes live), and return the summary text. Costs a Gemini
   * call + a vision capture — deliberate, agent-invoked, NOT per-turn. `streamId`
   * is the dock's live camera stream (for the vision flush); omit if none.
   */
  forceCurrent(dockId: string, streamId?: string, windowMs?: number): Promise<{ summary: string; error?: string; window: { from: string; to: string } }>;
}

const groundingRef: { current?: PerceptionGroundingApi } = {};
/** The live PerceptionGroundingApi (set when the perception module inits). */
export function getPerceptionGrounding(): PerceptionGroundingApi | undefined {
  return groundingRef.current;
}


export function perceptionModule(getHub: () => ProcessingHub): StationModule {
  let state: PerceptionState;
  const snapshots = new SnapshotStore(); // WebRTC vision+speech snapshot records
  const takes = new TakeStore();         // frozen snapshot bundles for A/B replay
  // Latest produced summary PER DOCK — the head of perception grounding (3.1). Set
  // on each successful /snapshots/summarize; read synchronously by the brain facade.
  const lastSummary = new Map<string, LastSummary>();
  let bus: Bus;
  const gallery = new Gallery(GALLERY_PATH);
  const face = faceRecognitionProcessor(gallery);
  const stt = sttWatchProcessor(snapshots);        // 🎙 speech (exposes flushAll)
  // Vision reuses the face processor's decoded frame (ONE ffmpeg per dock, not two).
  const vision = visionSnapshotProcessor(snapshots, (sid) => face.currentFrame(sid)); // 👁 vision (captureNow)
  const bodymotion = bodyMotionWatchProcessor(snapshots); // 🤖 ego-motion (setMotion seam)

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
      // ONE WebRTC perception pipeline. The browser publishes mic+cam to the SFU;
      // these processors tap that stream. Vision = qwen (scene+action, one model,
      // latency-bound windows); speech = whisper utterances. Both emit shared-format
      // snapshot records (IST from/to/duration + source) into the SnapshotStore.
      hub.register(presenceProcessor());
      hub.register(face);
      // THREE snapshot streams, same format, kept separate (LLM merge later):
      hub.register(stt);    // 🎙 speech (whisper)
      hub.register(vision); // 👁 vision (qwen, no identity)
      hub.register(bodymotion); // 🤖 ego-motion (robot proprioception; station feeds commands)
      hub.register(identitySnapshotProcessor(snapshots, // 👤 identity (face-api + boxes)
        (sid) => face.recognizeAllCurrent(sid),
        (sid) => bodymotion.current(sid))); // ego-aware: don't drop people mid-move

      // Perception grounding facade for the brain (3.1): synchronously build the
      // per-turn context block for a dock — last summary (with staleness) + the raw
      // stream since it, from this dock's records. No network; the brain injects it.
      groundingRef.current = {
        forDock(dockId: string): string | undefined {
          const now = Date.now();
          // this dock's recent records (the store mixes docks; records are tagged).
          const recent = snapshots.list().filter((r) => r.dockId === dockId);
          const block = buildGrounding({
            last: lastSummary.get(dockId) ?? null,
            recent,
            now,
            nowIso: isoIst(new Date(now)),
          });
          return block ?? undefined;
        },
        async forceCurrent(dockId, streamId, windowMs) {
          // 1) FLUSH the in-flight tail so "right now" is captured (mirrors the
          //    console's Summarize flush): force-end open utterances + a one-shot
          //    vision capture, both awaited before we pin the window.
          try { await stt.flushAll(); } catch { /* best-effort */ }
          if (streamId) { try { await vision.captureNow(streamId); } catch { /* best-effort */ } }
          // 2) PIN the window NOW (after the flush committed) and summarize it.
          const toIso = isoIst(new Date());
          const fromIso = isoIst(new Date(Date.now() - (windowMs ?? 60_000)));
          const recs = snapshots.inWindowWithState(fromIso, toIso)
            .filter((r) => r.dockId === dockId); // this dock only
          const result = await summarize(recs);
          // 3) CACHE as the dock's last summary so grounding (3.1) goes live — the
          //    first real producer of summaries (the console click is the only other).
          if (result.summary && !result.error) {
            lastSummary.set(dockId, {
              dockId, text: result.summary,
              window: { from: fromIso, to: toIso }, computedAt: Date.now(),
            });
          }
          return { summary: result.summary, error: result.error, window: { from: fromIso, to: toIso } };
        },
      };

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
      // Snapshot records (WebRTC vision + speech), shared format, ordered by start.
      // GET /snapshots[?limit=N]; POST /snapshots/clear wipes the ring.
      if (req.method === 'GET' && subPath === '/snapshots') {
        const limit = Number(new URL(req.url ?? '', 'http://x').searchParams.get('limit') ?? 300);
        json(res, 200, snapshots.list(limit));
        return true;
      }
      if (req.method === 'POST' && subPath === '/snapshots/clear') {
        snapshots.clear();
        json(res, 200, { ok: true });
        return true;
      }
      // Flush in-flight perception so a Summarize right after captures the NOW:
      // force-commit any open utterance + take a fresh one-shot vision analysis,
      // awaiting both so they're in the store before the (separate) summarize call.
      // POST /snapshots/flush {streamId?} → {ok, vision:bool}
      if (req.method === 'POST' && subPath === '/snapshots/flush') {
        const body = await parseBody<{ streamId?: string }>(req);
        await stt.flushAll(); // every audio stream's open utterance
        let visionCommitted = false;
        if (body.streamId) visionCommitted = await vision.captureNow(body.streamId);
        json(res, 200, { ok: true, vision: visionCommitted });
        return true;
      }
      // Inject a robot MOTION COMMAND (the station's contract; or a mock for testing).
      // POST /bodymotion {streamId, mode, direction?, durationMs, amount?, label?}
      // → records a 'camera moving' snapshot + marks the camera unsettled for
      //   durationMs + settle tail (so identity won't drop people mid-move).
      if (req.method === 'POST' && subPath === '/bodymotion') {
        const body = await parseBody<{ streamId?: string } & MotionCommand>(req);
        if (!body.streamId || !body.mode || body.durationMs == null) {
          json(res, 400, { error: 'bodymotion needs streamId, mode, durationMs' });
          return true;
        }
        const ok = bodymotion.pushCommand(body.streamId, {
          mode: body.mode, direction: body.direction, durationMs: body.durationMs,
          amount: body.amount, label: body.label, at: body.at,
        });
        json(res, ok ? 200 : 404, { ok, reason: ok ? undefined : 'stream not found' });
        return true;
      }
      // Summarize the last `windowMs` of snapshots via Gemini. Optional keyframes.
      // POST /snapshots/summarize {windowMs, withKeyframes?, maxKeyframes?}
      // → {summary, model, counts, prompt:{system,transcript}, withKeyframes, error?}
      if (req.method === 'POST' && subPath === '/snapshots/summarize') {
        const body = await parseBody<
          { windowMs?: number; fromIso?: string; toIso?: string;
            withKeyframes?: boolean; maxKeyframes?: number; model?: string }>(req);
        // Prefer EXPLICIT bounds (the client pins the window at click time so the
        // log and the LLM input agree exactly). Fall back to windowMs = [now-w, now]
        // for older callers. inWindowWithState = overlap + carried-in state streams.
        const toIso = body.toIso ?? isoIst(new Date());
        const fromIso = body.fromIso ?? isoIst(new Date(Date.now() - (body.windowMs ?? 60_000)));
        // inWindowWithState carries forward the last identity/bodymotion BEFORE the
        // window, so the summary knows the camera/presence state it ENTERED with
        // (a pan or a person that last changed before the window isn't lost).
        const recs = snapshots.inWindowWithState(fromIso, toIso);
        const keyframes = body.withKeyframes
          ? snapshots.keyframesInWindow(fromIso, toIso, body.maxKeyframes ?? 6) : undefined;
        const result = await summarize(recs, { keyframes, model: body.model });
        // Cache it as the head of grounding (3.1) for whichever dock this window is
        // about — the dominant dockId in the summarized records. A real (non-empty,
        // non-error) summary only; an error/empty leaves the prior summary in place.
        const dockId = dominantDock(recs);
        if (dockId && result.summary && !result.error) {
          lastSummary.set(dockId, {
            dockId, text: result.summary,
            window: { from: fromIso, to: toIso }, computedAt: Date.now(),
          });
        }
        // Echo the exact window used so the console can pin its log to it.
        json(res, 200, { ...result, window: { from: fromIso, to: toIso } });
        return true;
      }
      // --- TAKES: freeze a window to disk for apples-to-apples A/B replay ------
      // Save the current window (or all) as a named, immutable take.
      // POST /takes/save {name, windowMs?}  (omit windowMs → save everything)
      if (req.method === 'POST' && subPath === '/takes/save') {
        const body = await parseBody<{ name?: string; windowMs?: number }>(req);
        const name = body.name?.trim();
        if (!name) { json(res, 400, { error: 'take needs a name' }); return true; }
        const recs = body.windowMs
          ? snapshots.since(isoIst(new Date(Date.now() - body.windowMs)))
          : snapshots.list();
        const kf = body.windowMs
          ? snapshots.keyframesAllSince(isoIst(new Date(Date.now() - body.windowMs)))
          : snapshots.keyframesAllSince('');
        if (recs.length === 0) { json(res, 400, { error: 'nothing to save in this window' }); return true; }
        json(res, 200, takes.save(name, recs, kf));
        return true;
      }
      // List saved takes (metadata only).  GET /takes
      if (req.method === 'GET' && subPath === '/takes') {
        json(res, 200, takes.list());
        return true;
      }
      // Summarize a SAVED take — same fixed input, varied prompt/model/keyframes.
      // POST /takes/summarize {name, withKeyframes?, maxKeyframes?, model?}
      if (req.method === 'POST' && subPath === '/takes/summarize') {
        const body = await parseBody<
          { name?: string; withKeyframes?: boolean; maxKeyframes?: number; model?: string }>(req);
        const take = body.name ? takes.load(body.name) : null;
        if (!take) { json(res, 404, { error: 'no such take' }); return true; }
        const keyframes = body.withKeyframes
          ? sampleEvenly(take.keyframes, body.maxKeyframes ?? 6) : undefined;
        json(res, 200, { ...await summarize(take.records, { keyframes, model: body.model }),
          take: take.name, window: take.range });
        return true;
      }
      // Load a take's records into the view (so the log shows the frozen data).
      // GET /takes/load?name=…
      if (req.method === 'GET' && subPath === '/takes/load') {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        const take = takes.load(name);
        if (!take) { json(res, 404, { error: 'no such take' }); return true; }
        json(res, 200, { name: take.name, range: take.range, counts: take.counts, records: take.records });
        return true;
      }
      if (req.method === 'POST' && subPath === '/takes/delete') {
        const body = await parseBody<{ name?: string }>(req);
        json(res, 200, { deleted: body.name ? takes.delete(body.name) : false });
        return true;
      }
      // Steer the vision instruction. GET → {base, extra}; POST {extra} sets it.
      if (req.method === 'GET' && subPath === '/instruction') {
        json(res, 200, { base: visionBase(), extra: getVisionExtra() });
        return true;
      }
      if (req.method === 'POST' && subPath === '/instruction') {
        const body = await parseBody<{ extra?: string }>(req);
        setVisionExtra(body.extra ?? '');
        json(res, 200, { base: visionBase(), extra: getVisionExtra() });
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
        const body = await parseBody<{ name?: string; index?: number }>(req);
        const removed = body.name != null && typeof body.index === 'number'
          ? gallery.removeSample(body.name, body.index) : false;
        json(res, 200, { removed });
        return true;
      }
      // Enroll the face currently on screen for a dock: { streamId, name }.
      if (req.method === 'POST' && subPath === '/enroll') {
        const body = await parseBody<{ streamId?: string; name?: string }>(req);
        if (!body.streamId || !body.name) {
          json(res, 400, { error: 'enroll needs streamId + name' });
          return true;
        }
        const result = await face.enrollCurrent(body.streamId, body.name.trim());
        json(res, result.ok ? 200 : 409, result);
        return true;
      }
      if (req.method === 'POST' && subPath === '/gallery/remove') {
        const body = await parseBody<{ name?: string }>(req);
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
        const body = await parseBody<PerceptionResult>(req);
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

/** Read + JSON-parse a request body, tolerating an empty OR malformed body by
 *  returning {}. route() isn't wrapped in a try/catch upstream, so a raw
 *  JSON.parse throw would reject the request promise and HANG the client (no
 *  response). Every route validates required fields, so {} is handled gracefully. */
async function parseBody<T>(req: IncomingMessage): Promise<Partial<T>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw) as Partial<T>; } catch { return {}; }
}
