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

interface Stream {
  ctx: StreamContext;
  grabber: FrameGrabber;
  lastRunMs: number;
  busy: boolean;
  current: string | null; // last emitted identity name (null = unrecognized/absent)
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
      // emit only on change (present→name, name→other, →lost)
      if (name !== s.current) {
        s.current = name;
        s.ctx.emit({ kind: 'identity', payload: { name }, source: 'face-recognition', confidence });
      }
    } catch { /* a bad frame — try again next tick */ } finally {
      s.busy = false;
    }
  }

  return {
    id: 'face-recognition',
    sources: '*',
    mediaKinds: ['video'] as readonly MediaKind[],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      const grabber = new FrameGrabber();
      grabber.start();
      streams.set(ctx.streamId, { ctx, grabber, lastRunMs: 0, busy: false, current: null });
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
      // mark identity lost so the dock drops a stale name.
      if (s.current !== null) s.ctx.emit({ kind: 'identity', payload: { name: null }, source: 'face-recognition' });
      s.grabber.stop();
      streams.delete(streamId);
    },

    /** Enroll the face currently on screen for a dock under `name`. */
    async enrollCurrent(streamId, name) {
      const s = streams.get(streamId);
      if (!s) return { ok: false, reason: 'dock not streaming' };
      const jpeg = s.grabber.latest();
      if (!jpeg) return { ok: false, reason: 'no frame yet' };
      const descriptor = await describeFace(jpeg);
      if (!descriptor) return { ok: false, reason: 'no face detected in frame' };
      gallery.enroll(name, descriptor);
      // re-run so the new identity reflects immediately.
      s.current = null;
      return { ok: true };
    },
  };
}
