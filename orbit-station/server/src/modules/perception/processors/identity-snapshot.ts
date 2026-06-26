/**
 * IdentitySnapshotProcessor — the WHO stream. Separate from vision (what's
 * happening) and speech (what's said): face recognition runs on a cadence over the
 * SFU video stream and emits, per window, the list of ALL faces with their name
 * (or null) and normalized bounding box. Multiple people are first-class — each
 * gets its own {name, box}.
 *
 * It does NOT touch qwen's vision text. Identity is kept as its own snapshot
 * stream (shared format) so a later LLM merge can fuse who+what+said using the
 * boxes to line people up spatially ("Guru on the left said …"). No string-replace.
 */

import type { StreamContext, StreamProcessor } from '../processor.js';
import { makeSnapshot, type SnapshotStore } from '../snapshots.js';
import type { FaceIdentity } from './face-recognition.js';

/** How often to run face recognition (cheap; ~tens of ms per frame). */
const PERIOD_MS = Number(process.env.IDENTITY_PERIOD_MS ?? 2000);

export type RecognizeAll = (streamId: string) => Promise<FaceIdentity[]>;

/** Hysteresis: a name must be seen this many consecutive samples before we call it
 *  "present", and missed this many before "left". Kills the every-2 s flicker AT
 *  THE SOURCE so the live feed, summary, and brain all get clean presence. */
const CONFIRM = Number(process.env.IDENTITY_CONFIRM ?? 2); // samples to confirm present
const DROP = Number(process.env.IDENTITY_DROP ?? 2);       // misses to confirm left
// Emotion gating — DESCRIPTIVE + HEDGED, not a forced argmax label. face-api's
// expression net force-fits (a calm face can read "angry 0.73"), so we (a) require
// the top emotion to be both reasonably strong AND clearly ahead of 2nd place, and
// (b) phrase by confidence ("looked" only when strong+clear, else "seemed a little
// …"), staying SILENT when it's ambiguous. The full distribution rides on the record.
/** Top must reach this to be worth mentioning at all. */
const EMOTION_MIN = Number(process.env.EMOTION_MIN ?? 0.45);
/** Top must beat 2nd place by this margin (else it's a toss-up → say nothing). */
const EMOTION_MARGIN = Number(process.env.EMOTION_MARGIN ?? 0.25);
/** At/above this (and clear margin) we state it plainly ("looked X"); below → hedge. */
const EMOTION_STRONG = Number(process.env.EMOTION_STRONG ?? 0.7);

/** The expression payload face-api gives us — same shape as FaceIdentity.expression. */
type Expr = NonNullable<FaceIdentity['expression']>;

/** Turn a raw expression distribution into an honest phrase, or null to stay
 *  silent. Derives the winner from `all` (the full distribution) so it can also
 *  weigh the 2nd-place margin. Returns the wording + score + margin (for the record). */
function describeExpression(ex: Expr): { text: string; emotion: string; score: number; margin: number } | null {
  const sorted = Object.entries(ex.all).sort((a, b) => b[1] - a[1]);
  const [topName, topScore] = sorted[0] ?? ['neutral', 0];
  const margin = topScore - (sorted[1]?.[1] ?? 0);
  if (topName === 'neutral') return null;          // dominant signal is "no emotion"
  if (topScore < EMOTION_MIN || margin < EMOTION_MARGIN) return null; // weak/ambiguous → silent
  // Strong AND clear → state it; otherwise hedge the wording so we don't assert.
  const strong = topScore >= EMOTION_STRONG && margin >= EMOTION_STRONG - 0.2;
  const verb = strong ? 'looked' : 'seemed a little';
  return { text: `${verb} ${topName}`, emotion: topName, score: topScore, margin };
}

interface Tracked { face: FaceIdentity; hits: number; misses: number; present: boolean }

interface StreamState {
  ctx: StreamContext;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  /** per-name presence tracker (keyed by name, or 'unknown@<pos>' for unmatched). */
  tracked: Map<string, Tracked>;
  last: string; // last EMITTED confirmed signature
  lastEmotion: Map<string, string>; // per-person last emitted emotion (debounce)
}

function faceKey(f: FaceIdentity): string {
  return f.name ?? `unknown@${f.box.x < 0.33 ? 'L' : f.box.x > 0.66 ? 'R' : 'C'}`;
}

/** Readable label for the confirmed-present set. */
function label(faces: FaceIdentity[]): string {
  if (faces.length === 0) return 'no one in view';
  return faces.map((f) => f.name ?? (f.tentative ? `${f.tentative}?` : 'unknown person')).join(', ');
}

/** Optional ego-motion getter: the robot's current camera-motion state. When the
 *  camera is 'moving', a face going out of frame is likely the ROBOT panning away,
 *  not the person leaving — so we DON'T count those misses toward "left". */
export type CameraMotion = (streamId: string) => 'stationary' | 'moving';

export function identitySnapshotProcessor(
  store: SnapshotStore, recognizeAll: RecognizeAll, cameraMotion?: CameraMotion,
): StreamProcessor {
  const streams = new Map<string, StreamState>();

  const run = async (streamId: string) => {
    const s = streams.get(streamId);
    if (!s || s.busy) return;
    s.busy = true;
    const from = new Date();
    try {
      const seen = await recognizeAll(streamId);
      const to = new Date();
      const seenKeys = new Set(seen.map(faceKey));
      // EGO-MOTION GUARD: while the camera is moving, faces leave/enter the frame
      // because of the ROBOT, not the world. Freeze presence (don't accrue misses)
      // so we neither drop someone the robot panned past nor invent arrivals.
      const moving = cameraMotion?.(streamId) === 'moving';

      // 1) update trackers: increment hits for seen, misses for unseen.
      for (const f of seen) {
        const k = faceKey(f);
        const t = s.tracked.get(k) ?? { face: f, hits: 0, misses: 0, present: false };
        t.face = f; t.hits++; t.misses = 0;
        if (!t.present && t.hits >= CONFIRM) t.present = true; // CONFIRM enter
        s.tracked.set(k, t);
      }
      for (const [k, t] of s.tracked) {
        if (seenKeys.has(k)) continue;
        if (moving) continue; // camera moving → a miss isn't evidence they left
        t.misses++; t.hits = 0;
        if (t.present && t.misses >= DROP) t.present = false; // CONFIRM leave
        if (!t.present && t.misses > DROP + 2) s.tracked.delete(k); // forget stale
      }

      // 2) the CONFIRMED present set.
      const present = [...s.tracked.values()].filter((t) => t.present).map((t) => t.face);

      // 2a) SALIENT EMOTION: only when the expression net gives a STRONG, CLEAR,
      //     non-neutral read (see describeExpression — it hedges or stays silent
      //     otherwise, so we don't force-fit "angry" onto a calm face). Debounced
      //     per person+wording so we mark the onset, not every frame.
      for (const f of present) {
        const who = f.name ?? faceKey(f);
        const d = f.expression ? describeExpression(f.expression) : null;
        if (d) {
          if (s.lastEmotion.get(who) !== d.text) {
            s.lastEmotion.set(who, d.text);
            store.add(makeSnapshot({
              dockId: s.ctx.dockId,
              source: { id: s.ctx.streamId, kind: 'emotion', device: 'dock-webrtc', host: 'station' },
              model: { name: 'face-api-expression', endpoint: 'in-process' },
              from, to,
              payload: { text: `${f.name ?? 'someone'} ${d.text}`,
                         person: f.name, emotion: d.emotion, score: d.score, margin: d.margin,
                         // full distribution so the playground can see WHY it fired
                         all: f.expression!.all,
                         confidence: d.score, inferMs: to.getTime() - from.getTime() },
            }));
          }
        } else {
          s.lastEmotion.delete(who); // ambiguous/neutral now → reset so the next clear spike re-fires
        }
      }

      // 2b) presence change → emit identity record (with expression + mouthOpen).
      const sig = label(present);
      if (sig === s.last) return;
      s.last = sig;
      // representative confidence = best match among the present faces (0 if none).
      const confidence = present.reduce((m, f) => Math.max(m, f.confidence ?? 0), 0);
      store.add(makeSnapshot({
        dockId: s.ctx.dockId,
        source: { id: s.ctx.streamId, kind: 'identity', device: 'dock-webrtc', host: 'station' },
        model: { name: 'face-api', endpoint: 'in-process' },
        from, to,
        // faces = confirmed (name+box+expr+mouthOpen); inferMs = recognition compute.
        payload: { text: sig, faces: present, confidence, inferMs: to.getTime() - from.getTime() },
      }));

      // PUSH the recognized name to the dock so the phone's `perceive` stream can carry it
      // (the phone folds UserIdentified into each perceive frame → faceFollow NAMED mode can
      // match by name). The most-confident RECOGNIZED present face wins; null when nobody is
      // recognized (so the phone clears its identity). Mirrors presenceProcessor's ctx.emit.
      const named = present.filter((f) => f.name).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      s.ctx.emit({ kind: 'identity', payload: { name: named?.name ?? null }, source: 'identity-snapshot', confidence: named?.confidence ?? 0 });
    } finally {
      s.busy = false;
    }
  };

  return {
    id: 'identity-snapshot',
    sources: '*',
    mediaKinds: ['video'],
    channels: [],

    // No grabber/RTP here — identity reads the face processor's decoded frame via
    // recognizeAll(streamId). We only need a per-stream timer.
    onStreamStart(ctx: StreamContext) {
      const st: StreamState = { ctx, timer: null, busy: false, tracked: new Map(), last: '', lastEmotion: new Map() };
      st.timer = setInterval(() => void run(ctx.streamId), PERIOD_MS);
      streams.set(ctx.streamId, st);
    },

    onStreamEnd(streamId: string) {
      const s = streams.get(streamId);
      if (s?.timer) clearInterval(s.timer);
      streams.delete(streamId);
    },
  };
}
