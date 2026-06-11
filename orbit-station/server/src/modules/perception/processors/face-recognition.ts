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

const RECOGNIZE_EVERY_MS = 1000;
/** consecutive identical reads before a name is treated as stable (debounce). */
const STABLE_FRAMES = 2;
/** re-push the current identity this often so the app's state stays fresh. */
const KEEPALIVE_MS = 5000;

interface Stream {
  ctx: StreamContext;
  grabber: FrameGrabber;
  lastRunMs: number;
  busy: boolean;
  current: string | null;  // last EMITTED (stable) identity name
  pending: string | null;  // name seen in the most recent run(s)
  pendingCount: number;    // how many consecutive runs saw `pending`
  lastConfidence: number;  // confidence of the current identity
  keepalive?: ReturnType<typeof setInterval>;
}

export function faceRecognitionProcessor(gallery: Gallery): StreamProcessor & {
  enrollCurrent(streamId: string, name: string): Promise<{ ok: boolean; reason?: string }>;
} {
  const streams = new Map<string, Stream>();
  void loadFaceModels(); // warm the models at construction

  async function recognize(s: Stream, streamId: string, dockId: string): Promise<void> {
    const jpeg = s.grabber.latest();
    if (!jpeg) return;
    s.busy = true;
    try {
      const descriptor = await describeFace(jpeg);
      let name: string | null = null;
      let confidence = 0;
      if (descriptor) {
        const m = gallery.match(descriptor);
        if (m) { name = m.name; confidence = Math.max(0, 1 - m.distance); }
      }
      // Debounce HERE (the processor sees every frame): require N consecutive
      // identical reads before treating it as stable, so a single mis-frame
      // doesn't flip the name. Then emit only when the STABLE identity changes —
      // the state module trusts this directly (no second debounce).
      if (name === s.pending) {
        s.pendingCount++;
      } else {
        s.pending = name;
        s.pendingCount = 1;
      }
      if (s.pendingCount >= STABLE_FRAMES && name !== s.current) {
        s.current = name;
        s.lastConfidence = confidence;
        emitIdentity(s, name, confidence);
      } else if (name === s.current) {
        s.lastConfidence = confidence; // refresh confidence on continued match
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
      const s: Stream = { ctx, grabber, lastRunMs: 0, busy: false, current: null, pending: null, pendingCount: 0, lastConfidence: 0 };
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

    /** Enroll the face currently on screen for a dock under `name` (overwrites). */
    async enrollCurrent(streamId, name) {
      const s = streams.get(streamId);
      if (!s) return { ok: false, reason: 'dock not streaming' };
      const jpeg = s.grabber.latest();
      if (!jpeg) return { ok: false, reason: 'no frame yet' };
      const descriptor = await describeFace(jpeg);
      if (!descriptor) return { ok: false, reason: 'no face detected in frame' };
      gallery.enroll(name, descriptor); // overwrite (default) — "remember as X" replaces
      // reset so the new identity reflects immediately on the next recognize.
      s.current = null; s.pending = null; s.pendingCount = 0;
      return { ok: true };
    },
  };
}
