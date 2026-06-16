/**
 * TemporalWatchProcessor — the TEMPORAL tier of the perception pyramid
 * (docs/PERCEPTION-PYRAMID.md). Per-frame vision (vision-watch) says "what's
 * there"; this says "what's HAPPENING over time" — actions that need several
 * frames (waving, eating, leaving), which a single-image VLM can't infer.
 *
 * It keeps a rolling buffer of recently decoded JPEG frames (sampled ~1/sec from
 * the FrameGrabber), and every PERIOD_MS sends the last N frames to the
 * perception-sidecar /temporal endpoint (qwen2.5-VL via MLX, which reasons over
 * the frames as a video). It emits an `action` PerceptionResult.
 *
 * Why qwen-MLX and not moondream/md3: only a multi-frame/video model reasons
 * about motion; moondream on a single frame or a stitched grid can't reliably
 * (tested — see the temporal findings). qwen-3B via MLX gets motion right in ~3 s.
 */

import type { MediaKind } from '../../media/tap.js';
import type { RtpPacket } from 'werift';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { FrameGrabber } from '../face/frame-grabber.js';

const TEMPORAL_URL = process.env.TEMPORAL_SIDECAR_URL ?? 'http://127.0.0.1:8080';
/** How often to run a temporal pass. */
const PERIOD_MS = Number(process.env.TEMPORAL_PERIOD_MS ?? 4000);
/** Sample a frame into the buffer at most this often. */
const SAMPLE_MS = Number(process.env.TEMPORAL_SAMPLE_MS ?? 800);
/** How many recent frames to send (the "video" window). */
const WINDOW = Number(process.env.TEMPORAL_WINDOW ?? 5);

interface StreamState {
  ctx: StreamContext;
  grabber: FrameGrabber;
  buf: string[];          // recent frames as base64 JPEG (max WINDOW)
  lastSample: number;
  busy: boolean;
  sampleTimer: ReturnType<typeof setInterval> | null;
  runTimer: ReturnType<typeof setInterval> | null;
}

async function temporal(frames: string[]): Promise<string | null> {
  try {
    const r = await fetch(`${TEMPORAL_URL}/temporal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { response?: string }).response?.trim() || null;
  } catch {
    return null;
  }
}

export function temporalWatchProcessor(): StreamProcessor {
  const streams = new Map<string, StreamState>();

  const sample = (streamId: string) => {
    const s = streams.get(streamId);
    if (!s) return;
    if (Date.now() - s.lastSample < SAMPLE_MS) return;
    const jpeg = s.grabber.latest();
    if (!jpeg) return;
    s.lastSample = Date.now();
    s.buf.push(jpeg.toString('base64'));
    if (s.buf.length > WINDOW) s.buf.shift();
  };

  const run = async (streamId: string) => {
    const s = streams.get(streamId);
    if (!s || s.busy || s.buf.length < 2) return; // need a sequence
    s.busy = true;
    try {
      const frames = [...s.buf];
      const answer = await temporal(frames);
      if (answer) {
        s.ctx.emit({ kind: 'action', source: 'temporal-watch',
          payload: { description: answer, frames: frames.length }, confidence: 0.7 });
      }
    } finally {
      s.busy = false;
    }
  };

  return {
    id: 'temporal-watch',
    sources: '*',
    mediaKinds: ['video'],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      const grabber = new FrameGrabber();
      grabber.start();
      const state: StreamState = {
        ctx, grabber, buf: [], lastSample: 0, busy: false, sampleTimer: null, runTimer: null,
      };
      state.sampleTimer = setInterval(() => sample(ctx.streamId), Math.min(SAMPLE_MS, 400));
      state.runTimer = setInterval(() => void run(ctx.streamId), PERIOD_MS);
      streams.set(ctx.streamId, state);
    },

    onRtp(streamId: string, _kind: MediaKind, rtp: RtpPacket) {
      streams.get(streamId)?.grabber.feed(rtp);
    },

    onStreamEnd(streamId: string) {
      const s = streams.get(streamId);
      if (s?.sampleTimer) clearInterval(s.sampleTimer);
      if (s?.runTimer) clearInterval(s.runTimer);
      s?.grabber.stop();
      streams.delete(streamId);
    },
  };
}
