/**
 * VisionSnapshotProcessor — the WebRTC vision pipeline. Taps a dock's video
 * stream from the SFU, decodes frames (FrameGrabber), and runs LATENCY-BOUND
 * temporal analysis (qwen2.5-VL via the perception-sidecar): each analysis runs
 * back-to-back, and the window it covers is exactly however long it took. So at
 * ~4 s inference you get ~4 s windows with no fixed clock.
 *
 * Emits a shared-format SnapshotRecord per window (IST from/to/durationMs +
 * source provenance) into the SnapshotStore, AND a `scene` PerceptionResult so the
 * dock brain / world-state still see it. One model: qwen (scene + action in one
 * pass). The old per-frame moondream/md3 path is gone.
 */

import type { StreamContext, StreamProcessor } from '../processor.js';
import { makeSnapshot, isoIst, type SnapshotStore } from '../snapshots.js';
import { visionInstruction } from '../vision-instruction.js';

const TEMPORAL_URL = process.env.TEMPORAL_SIDECAR_URL ?? 'http://127.0.0.1:8080';
/** Frames per analysis window, spread over the capture span for temporal signal. */
const WINDOW_FRAMES = Number(process.env.VISION_WINDOW_FRAMES ?? 5);
const FRAME_GAP_MS = Number(process.env.VISION_FRAME_GAP_MS ?? 700);
const MODEL_NAME = 'qwen2.5-vl-3b-mlx-4bit';

/** Pull the latest decoded JPEG for a stream. Vision does NOT run its own ffmpeg
 *  grabber — it reuses the face processor's (one decode per dock, not two). */
export type GetFrame = (streamId: string) => Buffer | null;

interface StreamState {
  ctx: StreamContext;
  running: boolean;  // the steady loop is active
  busy: boolean;     // a capture (loop cycle OR flush) is mid-inference
}

/** Run one inference; return the text + the sidecar round-trip latency (inferMs). */
async function analyze(frames: string[], prompt: string): Promise<{ text: string; inferMs: number } | null> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${TEMPORAL_URL}/temporal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // SEND the steerable instruction — otherwise the sidecar uses its verbose
      // default prompt and ignores our anti-hallucination instruction entirely.
      body: JSON.stringify({ frames, prompt }), signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return null;
    const text = ((await r.json()) as { response?: string }).response?.trim();
    if (!text) return null;
    return { text, inferMs: Date.now() - t0 };
  } catch { return null; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function visionSnapshotProcessor(store: SnapshotStore, getFrame: GetFrame): StreamProcessor & {
  /** Capture + analyze the CURRENT frames right now and commit, awaiting the
   *  result. Used by the Summarize flush so the freshest visual moment is in the
   *  store before we summarize (the continuous loop's in-flight cycle hasn't
   *  committed yet). Samples fewer frames over a shorter span to stay snappy. */
  captureNow(streamId: string): Promise<boolean>;
} {
  const streams = new Map<string, StreamState>();

  /** Sample `n` frames `gapMs` apart, analyze, commit a vision snapshot. Returns
   *  true if a record was committed. Shared by the loop and the one-shot flush.
   *  Guarded by `s.busy` so the loop and a flush never run two concurrent
   *  inferences against the single-threaded MLX sidecar (callers check busy first). */
  async function captureOnce(s: StreamState, n: number, gapMs: number): Promise<boolean> {
    s.busy = true;
    try {
      return await doCapture(s, n, gapMs);
    } finally {
      s.busy = false;
    }
  }

  async function doCapture(s: StreamState, n: number, gapMs: number): Promise<boolean> {
    const from = new Date();
    const frames: string[] = [];
    for (let i = 0; i < n; i++) {
      const jpeg = getFrame(s.ctx.streamId);
      if (jpeg) frames.push(jpeg.toString('base64'));
      if (i < n - 1) await sleep(gapMs);
    }
    if (frames.length < 2) return false; // stream not live yet
    const res = await analyze(frames, visionInstruction());
    const to = new Date();
    if (!res) return false;
    const { text, inferMs } = res;
    // Vision describes WHAT (no identity). WHO is the separate identity stream
    // (face-api, with boxes); a later LLM merge fuses them. No string-replace.
    // latencyMs = whole window (sampling + inference); inferMs = sidecar compute only.
    store.add(makeSnapshot({
      dockId: s.ctx.dockId,
      source: { id: s.ctx.streamId, kind: 'vision', device: 'dock-webrtc', host: 'station' },
      model: { name: MODEL_NAME, endpoint: `${TEMPORAL_URL}/temporal` },
      from, to,
      payload: { text, frames: frames.length, latencyMs: to.getTime() - from.getTime(), inferMs },
    }));
    store.addKeyframe({ ts: isoIst(to), from: isoIst(from), jpegB64: frames[frames.length - 1]! });
    s.ctx.emit({ kind: 'scene', source: 'vision-snapshot', payload: { description: text }, confidence: 0.7 });
    return true;
  }

  /** Latency-bound loop: sample frames over a span, analyze, emit, repeat. */
  async function loop(streamId: string) {
    const s = streams.get(streamId);
    if (!s || s.running) return;
    s.running = true;
    while (streams.has(streamId)) {
      const committed = await captureOnce(s, WINDOW_FRAMES, FRAME_GAP_MS);
      if (!committed) await sleep(500); // stream not live yet / inference failed
    }
    s.running = false;
  }

  return {
    captureNow: async (streamId: string) => {
      const s = streams.get(streamId);
      if (!s) return false;
      // If the steady loop is mid-inference, don't fire a SECOND concurrent MLX call
      // (it would just queue behind the first on the single-threaded sidecar and
      // double flush latency). The loop is about to commit a fresh frame anyway, so
      // riding it is as good as a one-shot. Only run our own when the loop is idle.
      if (s.busy) return false;
      // Snappy one-shot: 2 recent frames ~250ms apart (enough for "what's happening
      // now"; the heavier 5-frame motion window is for the steady loop).
      return captureOnce(s, 2, 250);
    },
    id: 'vision-snapshot',
    sources: '*',
    // No media: vision reads frames from the face processor's grabber (getFrame),
    // so it needs stream LIFECYCLE but not its own RTP/decode. Started via the hub's
    // media-less lifecycle path (see ProcessingHub).
    mediaKinds: [],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      streams.set(ctx.streamId, { ctx, running: false, busy: false });
      void loop(ctx.streamId);
    },

    onStreamEnd(streamId: string) {
      streams.delete(streamId); // ends the loop
    },
  };
}
