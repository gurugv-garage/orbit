/**
 * FaceRecognitionProcessor — server-side identity. Per producer it decodes the
 * VP8 stream to ~1 fps frames (FrameGrabber → ffmpeg), embeds the most prominent
 * face (FaceRecognizer), matches it against the shared Gallery, and emits an
 * `identity` result (name, or null when a face is present but unrecognized). The
 * state module debounces + fuses this into the dock's world-state and the prompt.
 *
 * It also backs enrollment: `enrollCurrent(streamId, name)` grabs the current
 * frame for that dock, embeds it, and adds it to the gallery — "name the face on
 * screen", driven from the console.
 *
 * Cadence: recognize ~once/sec; emit `identity` only on CHANGE (enter / change /
 * lost) so we don't spam the bus. Decode runs in ffmpeg (a subprocess), and
 * embedding is the only main-loop cost — gated to 1/sec, it's negligible.
 */

import type { MediaKind } from '../../media/tap.js';
import type { RtpPacket } from 'werift';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { FrameGrabber } from '../face/frame-grabber.js';
import { Gallery, TENTATIVE_THRESHOLD } from '../face/gallery.js';
import { describeFace, describeAllFaces, loadFaceModels } from '../face/recognizer.js';
import { classifyDistance, TENTATIVE_THRESHOLD as TENT } from '../face/gallery.js';

/** One recognized face for the identity snapshot stream: who + where (box) +
 *  expression + mouth-openness (for emotion + active-speaker). */
export interface FaceIdentity {
  name: string | null;        // confident match, else null
  tentative: string | null;   // wider-band guess
  confidence: number;
  box: { x: number; y: number; w: number; h: number }; // normalized 0..1
  expression?: { top: string; score: number; all: Record<string, number> };
  mouthOpen?: number;
}

interface Stream {
  ctx: StreamContext;
  grabber: FrameGrabber;
}

export function faceRecognitionProcessor(gallery: Gallery): StreamProcessor & {
  enrollCurrent(streamId: string, name: string): Promise<{ ok: boolean; reason?: string }>;
  recognizeCurrent(streamId: string): Promise<{ name: string | null; tentative: string | null; confidence: number; noFace: boolean }>;
  /** ALL faces in the current frame, each with name + bounding box (for the
   *  identity snapshot stream — handles multiple people). */
  recognizeAllCurrent(streamId: string): Promise<FaceIdentity[]>;
  /** Confirm a tentative identity: append the current frame as more data for `name`. */
  confirmCurrent(streamId: string, name: string): Promise<{ ok: boolean }>;
  /** "That's not me": drop the wrong association so it stops mis-matching. */
  forgetCurrent(streamId: string, name: string): Promise<{ ok: boolean }>;
  currentFrame(streamId: string): Buffer | null;
  /** currentFrame, but only a frame decoded at/after `minTs` (visual-search:
   *  judge post-settle frames only, never a mid-move smear). */
  currentFrameSince(streamId: string, minTs: number): Buffer | null;
  /** The frame the camera was showing AT `tMs` (from the grabber's rolling window). */
  currentFrameAt(streamId: string, tMs: number): Buffer | null;
} {
  const streams = new Map<string, Stream>();
  void loadFaceModels(); // warm the models at construction

  // PULL-ONLY: no background recognition loop. The grabber keeps the latest frame
  // decoded; recognition happens only when the dock asks (recognizeCurrent ←
  // recollect_face / the STT-start trigger). The dock caches the result.

  return {
    id: 'face-recognition',
    sources: '*',
    mediaKinds: ['video'] as readonly MediaKind[],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      const grabber = new FrameGrabber();
      grabber.start();
      streams.set(ctx.streamId, { ctx, grabber });
    },

    onRtp(streamId: string, _kind: MediaKind, rtp: RtpPacket) {
      // Just keep the grabber's latest frame decoded; recognition is pull-only.
      streams.get(streamId)?.grabber.feed(rtp);
    },

    onStreamEnd(streamId: string) {
      const s = streams.get(streamId);
      if (!s) return;
      s.grabber.stop();
      streams.delete(streamId);
    },

    /**
     * Enroll the face on screen under `name` — ONE capture per call. A new name
     * starts the person; clicking Enroll again on the SAME name appends another
     * angle (the operator decides how many to add). Each sample keeps its photo.
     */
    async enrollCurrent(streamId, name) {
      const s = streams.get(streamId);
      if (!s) return { ok: false, reason: 'dock not streaming' };
      const jpeg = s.grabber.latest();
      if (!jpeg) return { ok: false, reason: 'no frame yet' };
      const descriptor = await describeFace(jpeg);
      if (!descriptor) return { ok: false, reason: 'no face detected in frame' };
      gallery.enroll(name, descriptor, jpeg.toString('base64'), gallery.has(name)); // append if known
      return { ok: true };
    },

    /**
     * Fresh, authoritative recognition of the dock's CURRENT frame — backs
     * recollect_face. Recomputes on demand (doesn't read the cached hint), so the
     * agent always gets the truth when it asks. null name = a face but no match;
     * `noFace` = nothing recognizable in frame.
     */
    async recognizeCurrent(streamId) {
      const s = streams.get(streamId);
      if (!s) return { name: null, tentative: null, confidence: 0, noFace: true };
      const jpeg = s.grabber.latest();
      if (!jpeg) return { name: null, tentative: null, confidence: 0, noFace: true };
      const descriptor = await describeFace(jpeg);
      if (!descriptor) return { name: null, tentative: null, confidence: 0, noFace: true };
      // confident match within the normal threshold ...
      const m = gallery.match(descriptor);
      if (m) return { name: m.name, tentative: null, confidence: Math.max(0, 1 - m.distance), noFace: false };
      // ... else a TENTATIVE match in a wider band → the agent hedges / asks to
      // confirm, and confirm_face enrolls this frame as more data (learning loop).
      const t = gallery.match(descriptor, TENTATIVE_THRESHOLD);
      return { name: null, tentative: t?.name ?? null, confidence: t ? Math.max(0, 1 - t.distance) : 0, noFace: false };
    },

    /** ALL faces in the current frame → identity + box. Empty when no faces. */
    async recognizeAllCurrent(streamId): Promise<FaceIdentity[]> {
      const s = streams.get(streamId);
      if (!s) return [];
      const jpeg = s.grabber.latest();
      if (!jpeg) return [];
      let faces;
      try { faces = await describeAllFaces(jpeg); } catch { return []; }
      return faces.map((f) => {
        const m = gallery.match(f.descriptor, TENT);
        const verdict = m ? classifyDistance(m.distance) : 'none';
        return {
          name: verdict === 'confident' ? m!.name : null,
          tentative: verdict === 'tentative' ? m!.name : null,
          confidence: m ? Math.max(0, 1 - m.distance) : 0,
          box: f.box,
          expression: f.expression,
          mouthOpen: f.mouthOpen,
        };
      });
    },

    /**
     * Confirm-and-learn: the user said "yes, I'm X" to a tentative guess. APPEND
     * the current frame's descriptor to X so the gallery gets a real sample from
     * THIS camera/lighting — recognition self-improves with each confirmation.
     */
    async confirmCurrent(streamId, name) {
      const s = streams.get(streamId);
      if (!s) return { ok: false };
      const jpeg = s.grabber.latest();
      if (!jpeg) return { ok: false };
      const descriptor = await describeFace(jpeg);
      if (!descriptor) return { ok: false };
      // keep the confirming frame's photo too, so the sample is viewable in the console.
      gallery.enroll(name, descriptor, jpeg.toString('base64'), true); // append (keep prior angles)
      return { ok: true };
    },

    /**
     * "That's not me" — the recognizer wrongly matched the current face as `name`
     * (low-res look-alike confusion). Drop that name's entry so it stops
     * mis-matching; the agent then asks who they really are and re-enrolls. Simple
     * and effective for the actual failure mode (no negative-exemplar machinery).
     */
    async forgetCurrent(_streamId, name) {
      return { ok: gallery.remove(name) };
    },

    /** DEBUG: the grabber's latest decoded JPEG (to inspect what we're seeing). */
    currentFrame(streamId: string): Buffer | null {
      return streams.get(streamId)?.grabber.latest() ?? null;
    },

    currentFrameSince(streamId: string, minTs: number): Buffer | null {
      return streams.get(streamId)?.grabber.latestSince(minTs) ?? null;
    },

    /** The frame the camera was showing AT `tMs` — the "look back to a moment"
     *  accessor over the grabber's rolling window (null if t predates the window). */
    currentFrameAt(streamId: string, tMs: number): Buffer | null {
      return streams.get(streamId)?.grabber.frameAt(tMs) ?? null;
    },
  };
}
