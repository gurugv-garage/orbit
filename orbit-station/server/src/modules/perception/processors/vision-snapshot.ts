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

import * as tf from '@tensorflow/tfjs-node';
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
  inflight?: Promise<boolean>; // the in-flight capture, so captureNow can await it
  /** the CHANGE GATE: a 16×16 grayscale signature of the last ANALYZED frame. The loop
   *  probes one frame every PROBE_MS (~1 ms of CPU via the already-loaded tfjs runtime)
   *  and only spends the ~4.5 s GPU inference when pixels actually moved past the
   *  threshold — a static scene was previously re-described 8×/min (2026-07-05). */
  lastSig?: Float32Array;
  lastAnalyzedAt: number;
  skippedProbes: number; // gated probes since the last analysis (surfaced in the payload)
  /** the previous window's description — fed back into the prompt so the model reports
   *  WHAT CHANGED as a separate structured field (not just a fresh description). */
  lastText?: string;
}

/** Change-gate knobs. delta is mean |Δ| on a 16×16 grayscale [0..1]: sensor noise on a
 *  static scene measures ≲0.02; a person entering/moving ≳0.05. REFRESH forces a real
 *  analysis even with no pixel change (guards slow drift below the threshold).
 *  PROBE_MS is deliberately SHORT — a probe costs ~1 ms of CPU, and slowing the SENSING
 *  is how significant frames get missed (the earlier doubling-pause design was wrong for
 *  exactly that reason; only the expensive interpretation should be gated, never the
 *  cheap looking). Worst-case change-detection latency = one probe interval. */
const PROBE_MS = Number(process.env.VISION_PROBE_MS ?? 1_500);
const DIFF_THRESHOLD = Number(process.env.VISION_DIFF_THRESHOLD ?? 0.03);
const REFRESH_MS = Number(process.env.VISION_REFRESH_MS ?? 300_000);

/** 16×16 grayscale ZERO-MEAN signature of a JPEG (null on decode failure). Subtracting
 *  the frame's own mean makes the gate exposure-invariant: a night camera's auto-exposure
 *  hunting shifts EVERY pixel at once (a pure brightness change) and used to beat the
 *  threshold with nothing structurally different in the scene — only SPATIAL change
 *  (something actually moved) survives the subtraction. tf.tidy frees every tensor. */
function frameSignature(jpeg: Buffer): Float32Array | null {
  try {
    return tf.tidy(() => {
      const img = tf.node.decodeJpeg(jpeg, 1);                       // grayscale HxWx1
      const small = tf.image.resizeBilinear(img as tf.Tensor3D, [16, 16]).div(255);
      return small.sub(small.mean()).dataSync() as Float32Array;
    });
  } catch { return null; }
}

/** Mean absolute difference between two signatures (0 = identical, 1 = inverted). */
function signatureDelta(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
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
    // Serialize all captures (steady loop + on-demand one-shots) on the single-threaded
    // MLX sidecar: if one is already running, chain after it rather than overlap.
    while (s.inflight) { try { await s.inflight; } catch { /* prior failed; we still run */ } }
    s.busy = true;
    const p = doCapture(s, n, gapMs);
    s.inflight = p;
    try {
      return await p;
    } finally {
      s.busy = false;
      if (s.inflight === p) s.inflight = undefined;
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
    // STRUCTURED output: the description PLUS an explicit "what changed" field, judged
    // against the PREVIOUS window's description (fed back as reference). The change is
    // the signal downstream actually wants — the description alone hides it.
    const prompt = `${visionInstruction()}\n\n`
      + 'Return STRICT JSON: {"description":"<the one-sentence description>",'
      + '"change":"<what SIGNIFICANTLY changed versus the previous description below, in a few words — or an empty string if nothing significant changed>"}'
      + (s.lastText ? `\nPREVIOUS description (from a few seconds ago): "${s.lastText}"` : '\nThere is no previous description (first look) — set "change" to "".')
      + '\nJSON only.';
    const res = await analyze(frames, prompt);
    const to = new Date();
    if (!res) return false;
    const { inferMs } = res;
    // Parse the structured reply; a model that ignores the JSON ask degrades gracefully
    // to "the whole reply is the description".
    let text = res.text; let change = '';
    try {
      const parsed = JSON.parse(res.text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { description?: string; change?: string };
      if (parsed.description?.trim()) text = parsed.description.trim();
      change = (parsed.change ?? '').trim();
    } catch { /* free-text fallback */ }
    // change is only meaningful AGAINST a previous description; and a model that echoes
    // the whole description into `change` (seen on the first look) or writes "the scene
    // remains unchanged" (seen live) is saying nothing — normalize those to empty.
    if (!s.lastText || change.toLowerCase() === text.toLowerCase()
        || /remains? (the same|unchanged)|no (significant )?changes?\b|nothing (significant(ly)? )?(has )?changed/i.test(change)) {
      change = '';
    }
    // Vision describes WHAT (no identity). WHO is the separate identity stream
    // (face-api, with boxes); a later LLM merge fuses them. No string-replace.
    // latencyMs = whole window (sampling + inference); inferMs = sidecar compute only.
    store.add(makeSnapshot({
      dockId: s.ctx.dockId,
      source: { id: s.ctx.streamId, kind: 'vision', device: 'dock-webrtc', host: 'station' },
      model: { name: MODEL_NAME, endpoint: `${TEMPORAL_URL}/temporal` },
      from, to,
      // gatedProbes = how many cheap change-checks concluded "nothing moved" since the
      // previous analysis (Studio observability for the GPU savings). `change` = the
      // model's own account of what differs vs the previous window (structured field).
      payload: { text, ...(change ? { change } : {}), frames: frames.length, latencyMs: to.getTime() - from.getTime(), inferMs, gatedProbes: s.skippedProbes },
    }));
    store.addKeyframe({ ts: isoIst(to), from: isoIst(from), jpegB64: frames[frames.length - 1]! });
    s.ctx.emit({ kind: 'scene', source: 'vision-snapshot', payload: { description: text, ...(change ? { change } : {}) }, confidence: 0.7 });
    s.lastText = text;
    // change-gate bookkeeping: remember what the ANALYZED scene looked like, so the
    // cheap probe can tell whether anything has moved since.
    s.lastSig = frameSignature(Buffer.from(frames[frames.length - 1]!, 'base64')) ?? s.lastSig;
    s.lastAnalyzedAt = Date.now();
    s.skippedProbes = 0;
    return true;
  }

  /** The CHANGE-GATED loop: every PROBE_MS grab ONE frame and compare its 16×16
   *  signature against the last analyzed scene (~1 ms CPU). Only when pixels moved
   *  past DIFF_THRESHOLD — or REFRESH_MS elapsed with no change (slow-drift guard) —
   *  run the full multi-frame window + the ~4.5 s GPU inference. A static room costs
   *  probes, not inferences; any visual change is analyzed within ~PROBE_MS. */
  async function loop(streamId: string) {
    const s = streams.get(streamId);
    if (!s || s.running) return;
    s.running = true;
    while (streams.has(streamId)) {
      let analyze = true;
      if (s.lastSig && Date.now() - s.lastAnalyzedAt < REFRESH_MS && !s.busy) {
        const jpeg = getFrame(s.ctx.streamId);
        const sig = jpeg ? frameSignature(jpeg) : null;
        if (sig && signatureDelta(sig, s.lastSig) < DIFF_THRESHOLD) {
          analyze = false;               // scene unchanged → no GPU this round
          s.skippedProbes++;
        }
      }
      if (analyze) {
        const committed = await captureOnce(s, WINDOW_FRAMES, FRAME_GAP_MS);
        if (!committed) { await sleep(500); continue; } // stream not live yet / inference failed
      }
      await sleep(PROBE_MS);
    }
    s.running = false;
  }

  return {
    captureNow: async (streamId: string) => {
      const s = streams.get(streamId);
      if (!s) return false;
      // An explicit "look right now" (force_get_current) MUST deliver a genuinely fresh
      // frame. captureOnce serializes on the single-threaded sidecar — so this chains
      // AFTER any in-flight steady-loop cycle, then samples NEW frames. Previously this
      // returned false when busy ("the loop will commit soon"), but the loop's frame was
      // sampled BEFORE the user acted — so "what do you see now?" described the stale
      // pre-action scene (a held-up hand read as "typing on a laptop"). The wait for one
      // queued inference (a couple seconds) is the right cost for an on-demand look.
      // Snappy one-shot: 2 recent frames ~250ms apart (the heavier 5-frame motion window
      // is for the steady loop).
      return captureOnce(s, 2, 250);
    },
    id: 'vision-snapshot',
    sources: '*',
    // No media: vision reads frames from the face processor's grabber (getFrame),
    // so it needs stream LIFECYCLE but not its own RTP/decode. Started via the hub's
    // media-less lifecycle path (see PerceptionProcessingHub).
    mediaKinds: [],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      streams.set(ctx.streamId, { ctx, running: false, busy: false, lastAnalyzedAt: 0, skippedProbes: 0 });
      void loop(ctx.streamId);
    },

    onStreamEnd(streamId: string) {
      streams.delete(streamId); // ends the loop
    },
  };
}
