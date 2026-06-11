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
import { Gallery } from '../face/gallery.js';
import { describeFace, loadFaceModels } from '../face/recognizer.js';

const RECOGNIZE_EVERY_MS = 500;   // 2 fps.
/** good reads to ADOPT a new recognized name (fast). */
const ADOPT_FRAMES = 2;
/** consecutive MISSES before clearing the held name (~CLEAR_FRAMES × 500ms). At
 *  8 that's ~4s of no-match before the hint drops — survives blur/angle blips. */
const CLEAR_FRAMES = 8;
/** consecutive NO-FACE frames before clearing (camera covered/gone) — fast. */
const GONE_FRAMES = 2;
/** re-push the current identity this often so the app's state stays fresh. */
const KEEPALIVE_MS = 3000;
/** wider band for a TENTATIVE match — the agent asks "are you X?" to confirm. */
const TENTATIVE_THRESHOLD = 0.78;

interface Stream {
  ctx: StreamContext;
  grabber: FrameGrabber;
  lastRunMs: number;
  busy: boolean;
  current: string | null;  // last EMITTED (held) identity name
  pending: string | null;  // a DIFFERENT name building up to adoption
  pendingCount: number;    // consecutive reads of `pending`
  missCount: number;       // consecutive misses (face present, no match) holding current
  goneCount: number;       // consecutive NO-FACE frames (covered/gone)
  lastConfidence: number;  // confidence of the current identity
  keepalive?: ReturnType<typeof setInterval>;
}

export function faceRecognitionProcessor(gallery: Gallery): StreamProcessor & {
  enrollCurrent(streamId: string, name: string): Promise<{ ok: boolean; reason?: string }>;
  recognizeCurrent(streamId: string): Promise<{ name: string | null; tentative: string | null; noFace: boolean }>;
  /** Confirm a tentative identity: append the current frame as more data for `name`. */
  confirmCurrent(streamId: string, name: string): Promise<{ ok: boolean }>;
  currentFrame(streamId: string): Buffer | null;
} {
  const streams = new Map<string, Stream>();
  void loadFaceModels(); // warm the models at construction

  async function recognize(s: Stream, streamId: string, dockId: string): Promise<void> {
    const jpeg = s.grabber.latest();
    if (!jpeg) return;
    s.busy = true;
    try {
      const descriptor = await describeFace(jpeg);
      const faceVisible = descriptor !== null; // a face was DETECTED (matched or not)
      let name: string | null = null;
      let confidence = 0;
      if (descriptor) {
        const m = gallery.match(descriptor);
        if (m) { name = m.name; confidence = Math.max(0, 1 - m.distance); }
      }
      // Distinguish "no face at all" (camera covered / person gone) from "face
      // present but this frame didn't match" (the flicker case). We only HOLD the
      // name through the flicker case; if NO face is visible we clear FAST, so
      // covering the camera drops the name almost immediately.
      if (name !== null && name === s.current) {
        // continued match — refresh + reset miss counters.
        s.lastConfidence = confidence;
        s.missCount = 0; s.goneCount = 0;
        s.pending = null; s.pendingCount = 0;
      } else if (name !== null && name !== s.current) {
        // a DIFFERENT recognized name — adopt after a few consistent reads.
        if (name === s.pending) s.pendingCount++; else { s.pending = name; s.pendingCount = 1; }
        s.missCount = 0; s.goneCount = 0;
        if (s.pendingCount >= ADOPT_FRAMES) {
          s.current = name; s.lastConfidence = confidence;
          s.pending = null; s.pendingCount = 0;
          emitIdentity(s, name, confidence);
        }
      } else {
        s.pending = null; s.pendingCount = 0;
        if (s.current !== null) {
          if (!faceVisible) {
            // NO face in frame (covered / gone) → clear fast.
            s.goneCount++;
            if (s.goneCount >= GONE_FRAMES) {
              s.current = null; s.lastConfidence = 0; s.goneCount = 0; s.missCount = 0;
              emitIdentity(s, null, 0);
            }
          } else {
            // face present but unmatched this frame → hold through brief misses.
            s.missCount++;
            if (s.missCount >= CLEAR_FRAMES) {
              s.current = null; s.lastConfidence = 0; s.missCount = 0; s.goneCount = 0;
              emitIdentity(s, null, 0);
            }
          }
        }
      }
    } catch { /* a bad frame — try again next tick */ } finally {
      s.busy = false;
    }
  }

  /** Emit the current identity (used by recognize on-change + the keepalive). */
  function emitIdentity(s: Stream, name: string | null, confidence: number): void {
    s.ctx.emit({ kind: 'identity', payload: { name }, source: 'face-recognition', confidence });
  }

  return {
    id: 'face-recognition',
    sources: '*',
    mediaKinds: ['video'] as readonly MediaKind[],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      const grabber = new FrameGrabber();
      grabber.start();
      const s: Stream = { ctx, grabber, lastRunMs: 0, busy: false, current: null, pending: null, pendingCount: 0, missCount: 0, goneCount: 0, lastConfidence: 0 };
      // Keepalive: re-push the current identity every ~5 s so the app's "who's in
      // frame now" stays fresh even with no change (and self-heals a missed frame).
      s.keepalive = setInterval(() => emitIdentity(s, s.current, s.lastConfidence), KEEPALIVE_MS);
      streams.set(ctx.streamId, s);
    },

    onRtp(streamId: string, _kind: MediaKind, rtp: RtpPacket) {
      const s = streams.get(streamId);
      if (!s) return;
      s.grabber.feed(rtp);
      const now = Date.now();
      if (!s.busy && now - s.lastRunMs >= RECOGNIZE_EVERY_MS) {
        s.lastRunMs = now;
        void recognize(s, streamId, s.ctx.dockId);
      }
    },

    onStreamEnd(streamId: string) {
      const s = streams.get(streamId);
      if (!s) return;
      if (s.keepalive) clearInterval(s.keepalive);
      // mark identity lost so the dock drops a stale name.
      if (s.current !== null) s.ctx.emit({ kind: 'identity', payload: { name: null }, source: 'face-recognition' });
      s.grabber.stop();
      streams.delete(streamId);
    },

    /**
     * Enroll the face on screen under `name`. Captures SEVERAL frames over ~1.5s
     * (the person naturally shifts a little) so the gallery holds multiple
     * descriptors — a much more robust match than a single shot, which is what
     * caused weak matches / "I don't recognize them". First descriptor overwrites
     * any prior face for the name; the rest append.
     */
    async enrollCurrent(streamId, name) {
      const s = streams.get(streamId);
      if (!s) return { ok: false, reason: 'dock not streaming' };
      let captured = 0;
      let thumb: string | undefined;
      for (let i = 0; i < 5; i++) {
        const jpeg = s.grabber.latest();
        if (jpeg) {
          const descriptor = await describeFace(jpeg);
          if (descriptor) {
            gallery.enroll(name, descriptor, thumb ? undefined : jpeg.toString('base64'), captured > 0);
            thumb ??= jpeg.toString('base64');
            captured++;
          }
        }
        if (i < 4) await new Promise((r) => setTimeout(r, 350)); // ~1.4s of angles
      }
      if (captured === 0) return { ok: false, reason: 'no face detected in frame' };
      // reset so the new identity reflects immediately on the next recognize.
      s.current = null; s.pending = null; s.pendingCount = 0; s.missCount = 0; s.goneCount = 0;
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
      if (!s) return { name: null, tentative: null, noFace: true };
      const jpeg = s.grabber.latest();
      if (!jpeg) return { name: null, tentative: null, noFace: true };
      const descriptor = await describeFace(jpeg);
      if (!descriptor) return { name: null, tentative: null, noFace: true };
      // confident match within the normal threshold ...
      const m = gallery.match(descriptor);
      if (m) return { name: m.name, tentative: null, noFace: false };
      // ... else a TENTATIVE match in a wider band → the agent asks to confirm,
      // and confirm_face enrolls this frame as more data (the learning loop).
      const t = gallery.match(descriptor, TENTATIVE_THRESHOLD);
      return { name: null, tentative: t?.name ?? null, noFace: false };
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
      gallery.enroll(name, descriptor, undefined, true); // append (keep prior angles)
      s.current = null; s.pending = null; s.pendingCount = 0; s.missCount = 0; s.goneCount = 0;
      return { ok: true };
    },

    /** DEBUG: the grabber's latest decoded JPEG (to inspect what we're seeing). */
    currentFrame(streamId: string): Buffer | null {
      return streams.get(streamId)?.grabber.latest() ?? null;
    },
  };
}
