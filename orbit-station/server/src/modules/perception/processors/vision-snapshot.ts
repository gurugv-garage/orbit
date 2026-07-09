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
import { embedFrame, embedDistance, embedderReady, embedGateStatus } from '../embed.js';

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
  /** the last ANALYZED frame's DINOv2 embedding — the SEMANTIC change-gate anchor. When
   *  the embedder is available this replaces the pixel signature: cosine distance to it
   *  decides whether the scene changed, robust to the lighting/compression jitter that
   *  false-fired the pixel gate. Pixels stay as fallback when the model is unavailable. */
  lastEmb?: Float32Array;
  lastAnalyzedAt: number;
  skippedProbes: number; // gated probes since the last analysis (surfaced in the payload)
  /** WHY the last analysis ran (scene-change / local-change / sense-wake / heartbeat /
   *  first-look) — committed onto the payload so gating is debuggable from the Studio. */
  lastTrigger?: string;
  /** PER-CELL NOISE FLOOR (learned): EMA of each cell's probe-to-probe jitter. A
   *  high-contrast edge (the bright upstairs light against a dark stairwell) jitters
   *  ±0.2+ with micro-shake/compression and re-triggered after every re-anchor
   *  (seen live 2026-07-08, max=0.23–0.26 on a static scene) — so significance is
   *  measured as delta MINUS the cell's own learned jitter, not against a fixed bar. */
  noiseFloor?: Float32Array;
  prevProbeSig?: Float32Array;
  /** last sense-wake-triggered analysis: audio earns ONE look per episode, not one per
   *  utterance (continuous conversation re-woke vision every ~20 s to re-describe an
   *  unchanged scene — seen live 2026-07-08). Pixels still trigger instantly. */
  lastSenseWakeAt?: number;
  /** RECENT-ANALYSIS CACHE: the last few views we actually described, so a pan that sweeps
   *  back to a just-seen view (staircase → gym → staircase) REUSES the description instead
   *  of re-calling the 5 s VLM. Bounded + expiring — a recent memory, not a database. */
  recent?: Array<{ emb: Float32Array; text: string; at: number; frameB64: string }>;
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
/** a single 16×16 cell changing this much ABOVE ITS LEARNED NOISE FLOOR = something
 *  moved locally (person-sized-at-distance change the mean dilutes). Cells are ±~0.5. */
const CELL_THRESHOLD = Number(process.env.VISION_CELL_THRESHOLD ?? 0.12);
/** noise-floor learning rate (EMA per probe) + the floor multiple subtracted before
 *  thresholding (3× ≈ "outside this cell's normal jitter band"). */
const NOISE_EMA = 0.1;
const NOISE_K = 5;   // headroom over a flickery edge cell's learned jitter (3 tripped on 0.12-0.18 static residuals)
/** at most one sense-wake look per this window (continuous audio ≠ visual change). */
const SENSE_WAKE_COOLDOWN_MS = Number(process.env.VISION_SENSE_WAKE_COOLDOWN_MS ?? 120_000);
const REFRESH_MS = Number(process.env.VISION_REFRESH_MS ?? 300_000);
/** SEMANTIC gate: cosine distance between L2-normalized DINOv2 embeddings above which the
 *  scene is "meaningfully changed" (0=identical). Tuned on the real dock: static-scene
 *  probe-to-probe distance sits ~0.00-0.02 (lighting/compression), a person/object change
 *  is >=0.1. 0.06 sits in the clean gap. Env-tunable while dialing in. */
const EMBED_THRESHOLD = Number(process.env.VISION_EMBED_THRESHOLD ?? 0.06);
/** VISION_EMBED_DEBUG=1 → log every probe's embedding distance (bring-up/tuning). Verified
 *  live 2026-07-09: static dim scene ~0.006-0.02, a person walking in 0.25-0.53 — a huge
 *  clean gap, so 0.06 is well-separated and not a knife-edge. */
const EMBED_DEBUG = process.env.VISION_EMBED_DEBUG === '1';
/** Defer a change-trigger while the head is panning (the view slid because WE moved, not
 *  the world) — a deferral, not a cache (no stale-description risk; the settled next probe
 *  re-checks). DEFAULT ON, validated live 2026-07-09: ~45% of would-be VLM calls during
 *  head motion suppressed, and confirmed a real change still fires the moment the head
 *  settles. VISION_SELFMOTION_SUPPRESS=0 disables it. */
const SELFMOTION_SUPPRESS = process.env.VISION_SELFMOTION_SUPPRESS !== '0';
/** RECENT-ANALYSIS CACHE (VISION_REUSE_CACHE=1, opt-in until proven): while panning, the
 *  dock sweeps the same few views repeatedly — reuse a fresh, near-identical view's
 *  description instead of re-calling the VLM. Guards (all deliberately tight): reuse only
 *  if embedding distance < REUSE_DIST (0.12: measured on the real dock — a physical
 *  return-to-same-view lands ~0.10 with servo/framing tolerance, while real scene changes
 *  fire at 0.4+, so 0.12 sits in the safe gap), the cached entry is younger than REUSE_TTL_MS,
 *  and we never hold more than
 *  REUSE_MAX entries. Short TTL is the safety: a person can't appear+vanish inside it
 *  without the embedding being far enough to MISS the cache. */
const REUSE_CACHE = process.env.VISION_REUSE_CACHE !== '0';
const REUSE_DIST = Number(process.env.VISION_REUSE_DIST ?? 0.12);
const REUSE_TTL_MS = Number(process.env.VISION_REUSE_TTL_MS ?? 20_000);
const REUSE_MAX = Number(process.env.VISION_REUSE_MAX ?? 8);
/** WINDOW DEDUP: the 5-frame window exists to capture MOTION ("what is happening across
 *  these frames"). On a static scene the 5 frames are near-identical, so we pay 5× the
 *  visual-token prefill to tell qwen "nothing moved" five times. Collapse consecutive
 *  frames whose embedding distance < DEDUP_DIST (tight — only true duplicates) down to the
 *  distinct ones; if the whole window collapses to ONE frame, send that single frame with a
 *  still-image prompt. Same embedder as the gate/cache — one extra embed per window frame
 *  (~25ms each), cheap against a ~5s inference it can shorten. VISION_WINDOW_DEDUP=0 disables. */
const WINDOW_DEDUP = process.env.VISION_WINDOW_DEDUP !== '0';
const DEDUP_DIST = Number(process.env.VISION_DEDUP_DIST ?? 0.03);
/** POST-INFERENCE RE-PROBE: the loop is blind while busy (~5s inference). A visual-only
 *  event that starts AND ends inside that window (someone silently crosses the frame) is
 *  missed — the next probe compares the settled post-event scene against the pre-event
 *  anchor and sees no change. After each inference, compare a FRESH frame against the
 *  pre-inference anchor; if it moved past EMBED_THRESHOLD, re-fire next tick instead of
 *  sleeping. Catches the "walked through while I was thinking" gap. VISION_REPROBE=0 disables. */
const REPROBE_AFTER_INFERENCE = process.env.VISION_REPROBE !== '0';

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

export function visionSnapshotProcessor(
  store: SnapshotStore,
  getFrame: GetFrame,
  /** Is the dock's camera moving (its head panned within the settle window)? Tagged onto
   *  each record (camMoving) to tell "the WORLD changed" from "I panned my own head" — a
   *  change-gate trigger while moving is likely self-motion, same scene. Sourced from the
   *  MotionExecutor's lastMotionAt (faceFollow's pans never reach the bodymotion stream). */
  cameraMoving?: (dockId: string) => boolean,
): StreamProcessor & {
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
    // Sample the head-moving state HERE (frame-capture time), not at commit ~5s later —
    // the tag must reflect when the FRAMES were taken, else a head that settled during the
    // VLM's latency mislabels a still-frame window as "moving" (self-diagnosis bug, fixed
    // 2026-07-09). OR across the window: moving at any point means motion blur may be present.
    let capturedMoving = cameraMoving?.(s.ctx.dockId) ?? false;
    const sampled: Array<{ b64: string; emb: Float32Array | null }> = [];
    for (let i = 0; i < n; i++) {
      const jpeg = getFrame(s.ctx.streamId);
      if (jpeg) sampled.push({ b64: jpeg.toString('base64'), emb: WINDOW_DEDUP ? await embedFrame(jpeg) : null });
      if (cameraMoving?.(s.ctx.dockId)) capturedMoving = true;
      if (i < n - 1) await sleep(gapMs);
    }
    if (sampled.length < 2) return false; // stream not live yet
    // WINDOW DEDUP — CONSECUTIVE-ONLY. The window is a TIME SEQUENCE, so a frame is a
    // duplicate only of its immediate predecessor, never of a non-adjacent one: with
    // [static, static, person, person-gone, static] frame 5 ≈ frame 1 by embedding but they
    // are DIFFERENT moments (scene returned to rest AFTER an event) — collapsing across the
    // gap would erase that. So we keep a frame iff it differs from the LAST KEPT frame by
    // >= DEDUP_DIST. Order preserved; only true runs of near-identical frames collapse. When
    // the whole window collapses to ONE, nothing moved the entire time → a single still frame.
    let kept = sampled;
    if (WINDOW_DEDUP && sampled.every((f) => f.emb)) {
      kept = [sampled[0]!];
      for (let i = 1; i < sampled.length; i++) {
        if (embedDistance(kept[kept.length - 1]!.emb!, sampled[i]!.emb!) >= DEDUP_DIST) kept.push(sampled[i]!);
      }
      if (EMBED_DEBUG && kept.length < sampled.length) {
        console.log(`[vision] ${s.ctx.dockId} window-dedup: ${sampled.length} → ${kept.length} distinct frame(s)`);
      }
    }
    const frames: string[] = kept.map((f) => f.b64);   // the (deduped) frames qwen actually sees
    const lastKept = kept[kept.length - 1]!;            // newest kept frame = the anchor/cache view
    const singleFrame = frames.length === 1;
    // STRUCTURED output: the description PLUS an explicit "what changed" field, judged
    // against the PREVIOUS window's description (fed back as reference). The change is
    // SIMPLE PROMPT (root fix, 2026-07-09): the elaborate two-line DESCRIPTION/CHANGE
    // format + a fed-back PREVIOUS description was POISONING a 3B model — it echoed the
    // stale "None visible" anchor into DESCRIPTION while correctly putting the person in
    // CHANGE, and we surfaced only DESCRIPTION → a plainly-visible person reported as
    // "None visible", repeated verbatim for minutes (verified live: the SAME frames +
    // this simple prompt caught "a person ascending a staircase" 3/3, the complex prompt
    // failed). A small model needs a small ask. No CHANGE field, no previous-anchor.
    // When the window collapsed to a single still frame (nothing moved), ask the still-image
    // question — a "what is happening ACROSS these frames" prompt about one frame is an odd
    // ask for the model. The steer (if any) still rides along via visionInstruction().
    const prompt = singleFrame ? visionInstruction('single') : visionInstruction();
    const res = await analyze(frames, prompt);
    const to = new Date();
    if (!res) return false;
    const { inferMs } = res;
    // First non-empty line, first sentence — strip any stray markdown/label the model adds.
    let text = res.text.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').replace(/^(DESCRIPTION|SCENE):\s*/i, '').trim();
    text = (text.split(/\n/).find((l) => l.trim())?.trim() ?? text);
    text = (text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text).trim();
    const change = ''; // change-field retired with the two-line format (it was the poison).
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
      // inputImages + inputPrompt = the EXACT frames + prompt qwen saw, attached for
      // leak-hunting in the Studio ("did it hallucinate, or was it in the frames?"). qwen
      // reasons over ALL `frames` in the window (a mini filmstrip, per the prompt), so we
      // store ALL of them — showing only the last would misrepresent the input (the very
      // leak this panel exists to catch). ~16-30KB each in a bounded ring — a debug cost.
      payload: { text, frames: frames.length, latencyMs: to.getTime() - from.getTime(), inferMs, gatedProbes: s.skippedProbes, gateTrigger: s.lastTrigger ?? 'on-demand',
        camMoving: capturedMoving,   // head moving DURING frame capture (not at commit ~5s later)
        // sampledFrames = frames grabbed; frames = distinct frames sent after consecutive-dedup.
        // sampledFrames > frames means the window had static runs collapsed (fewer visual tokens).
        sampledFrames: sampled.length, singleFrame,
        inputImages: frames, inputPrompt: prompt },
    }));
    store.addKeyframe({ ts: isoIst(to), from: isoIst(from), jpegB64: lastKept.b64 });
    s.ctx.emit({ kind: 'scene', source: 'vision-snapshot', payload: { description: text }, confidence: 0.7 });
    // change-gate bookkeeping: remember what the ANALYZED scene looked like, so the
    // cheap probe can tell whether anything has moved since.
    const lastJpeg = Buffer.from(lastKept.b64, 'base64');
    s.lastSig = frameSignature(lastJpeg) ?? s.lastSig;
    // Reuse the newest kept frame's embedding (already computed for dedup) as the anchor — no
    // re-embed. Falls back to a fresh embed if dedup was off/failed (emb null).
    const analyzedEmb = lastKept.emb ?? (await embedFrame(lastJpeg)) ?? undefined;
    s.lastEmb = analyzedEmb ?? s.lastEmb;                    // semantic anchor (null → pixel path)
    s.lastAnalyzedAt = Date.now();
    s.skippedProbes = 0;
    // RECENT-ANALYSIS CACHE: remember this view's description so a pan sweeping back to it
    // reuses it instead of re-calling the VLM. Only cache real (non-empty) descriptions.
    if (REUSE_CACHE && analyzedEmb && text.trim()) {
      // keep the analyzed frame too, so a reuse can show the ORIGINAL view it's reusing
      // alongside the current probe frame (verify the match by eye in the Studio).
      s.recent = [{ emb: analyzedEmb, text, at: Date.now(), frameB64: lastKept.b64 }, ...(s.recent ?? [])].slice(0, REUSE_MAX);
    }
    return true;
  }

  /** Commit a vision record with a REUSED description (cache hit — no VLM call). Advances
   *  the change-gate anchor to this frame's embedding so the loop doesn't immediately
   *  re-fire on the same view; tags reused:true so the Studio shows it wasn't a fresh look. */
  function commitReused(s: StreamState, hit: { text: string; dist: number; frameB64: string }, emb: Float32Array, currentB64: string): void {
    const now = new Date();
    // inputImages = [CURRENT probe frame, ORIGINAL analyzed frame] so the Studio can show
    // "reusing THIS view (left) → because it matches the view we already described (right)".
    // reusedFromB64 names which is the original; reusedDist is the embedding match distance.
    store.add(makeSnapshot({
      dockId: s.ctx.dockId,
      source: { id: s.ctx.streamId, kind: 'vision', device: 'dock-webrtc', host: 'station' },
      model: { name: MODEL_NAME, endpoint: `${TEMPORAL_URL}/temporal` },
      from: now, to: now,
      payload: { text: hit.text, frames: 0, latencyMs: 0, inferMs: 0, gatedProbes: s.skippedProbes,
        gateTrigger: 'reused', reused: true, reusedDist: hit.dist, camMoving: cameraMoving?.(s.ctx.dockId) ?? false,
        inputImages: [currentB64, hit.frameB64], reusedFromB64: hit.frameB64 },
    }));
    s.ctx.emit({ kind: 'scene', source: 'vision-snapshot', payload: { description: hit.text }, confidence: 0.7 });
    s.lastEmb = emb;               // anchor to the reused view (don't re-fire on it)
    s.lastAnalyzedAt = Date.now();
    s.skippedProbes = 0;
  }

  /** Cache lookup: does the probe embedding match a FRESH recently-analyzed view closely
   *  enough to reuse its description (skip the VLM)? Returns the reused text or null. */
  function reuseFromCache(s: StreamState, emb: Float32Array): { text: string; dist: number; frameB64: string } | null {
    if (!REUSE_CACHE || !s.recent?.length) return null;
    const now = Date.now();
    s.recent = s.recent.filter((e) => now - e.at < REUSE_TTL_MS);   // expire stale entries
    let best: { text: string; dist: number; frameB64: string } | null = null;
    for (const e of s.recent) {
      const d = embedDistance(emb, e.emb);
      if (d < REUSE_DIST && (!best || d < best.dist)) best = { text: e.text, dist: d, frameB64: e.frameB64 };
    }
    return best;
  }

  /** The CHANGE-GATED loop: every PROBE_MS grab ONE frame and compare its 16×16
   *  signature against the last analyzed scene (~1 ms CPU). Only when pixels moved
   *  past DIFF_THRESHOLD — or REFRESH_MS elapsed with no change (slow-drift guard) —
   *  run the full multi-frame window + the ~4.5 s GPU inference. A static room costs
   *  probes, not inferences; any visual change is analyzed within ~PROBE_MS. */
  /** Has another SENSE heard something salient since the last analysis? Confident
   *  speech or a notable sound near the camera's blind spot means LOOK NOW even if
   *  the pixels haven't crossed the threshold (a person can be audible before they
   *  are visually large enough to move the mean — the cross-sense wake). */
  function senseWake(s: StreamState): boolean {
    const sinceIso = isoIst(new Date(s.lastAnalyzedAt));
    return store.list(30).some((r) => {
      if (r.dockId !== s.ctx.dockId || r.interval.from <= sinceIso) return false;
      const p = r.payload as { confTier?: string; salience?: string };
      if (r.source.kind === 'speech') return (p.confTier ?? 'good') === 'good';
      if (r.source.kind === 'sound') return p.salience === 'notable' || p.salience === 'startling';
      return false;
    });
  }

  /** SEMANTIC change probe: cosine distance of this frame's DINOv2 embedding to the last
   *  ANALYZED frame's. Returns a trigger string if changed, false if not, null if the frame
   *  couldn't be probed (fail open). Updates s.lastEmb? no — the anchor is only reset on a
   *  real analysis (doCapture), so drift accumulates against a stable reference. */
  async function embedChanged(s: StreamState, jpeg: Buffer | null): Promise<{ trigger: string | false; emb: Float32Array } | null> {
    const emb = jpeg ? await embedFrame(jpeg) : null;
    if (!emb) return null;
    const d = embedDistance(emb, s.lastEmb!);
    if (EMBED_DEBUG) console.log(`[embed-probe] ${s.ctx.dockId} d=${d.toFixed(3)} ${d >= EMBED_THRESHOLD ? 'FIRE' : 'skip'} (thr ${EMBED_THRESHOLD})`);
    return { trigger: d >= EMBED_THRESHOLD ? `scene-change emb=${d.toFixed(3)}` : false, emb };
  }

  /** PIXEL change probe (fallback only): 16×16 signature vs the anchor, measured as EXCESS
   *  over each cell's learned probe-to-probe jitter (a flickery edge earns a high floor; a
   *  person exceeds the floor of the quiet cells they cover). Same return contract. */
  function pixelChanged(s: StreamState, jpeg: Buffer | null): string | false | null {
    const sig = jpeg ? frameSignature(jpeg) : null;
    if (!sig || !s.lastSig) return null;
    if (!s.noiseFloor) s.noiseFloor = new Float32Array(sig.length).fill(0.02);
    if (s.prevProbeSig) {
      for (let i = 0; i < sig.length; i++) {
        s.noiseFloor[i] = s.noiseFloor[i]! * (1 - NOISE_EMA) + Math.abs(sig[i]! - s.prevProbeSig[i]!) * NOISE_EMA;
      }
    }
    s.prevProbeSig = sig;
    let excessSum = 0; let excessMax = 0;
    for (let i = 0; i < sig.length; i++) {
      const excess = Math.max(0, Math.abs(sig[i]! - s.lastSig[i]!) - NOISE_K * s.noiseFloor[i]!);
      excessSum += excess; if (excess > excessMax) excessMax = excess;
    }
    const excessMean = excessSum / sig.length;
    if (excessMean >= DIFF_THRESHOLD) return `scene-change mean=${excessMean.toFixed(3)}`;
    if (excessMax >= CELL_THRESHOLD) return `local-change max=${excessMax.toFixed(2)}`;
    return false;
  }

  async function loop(streamId: string) {
    const s = streams.get(streamId);
    if (!s || s.running) return;
    s.running = true;
    // announce which gate is driving this stream, so it's never a mystery which path ran.
    void embedderReady().then((ok) => {
      const st = embedGateStatus();
      if (!st.enabled) console.log(`[vision] ${s.ctx.dockId}: change-gate = PIXEL (VISION_EMBED_GATE=0)`);
      else if (ok) console.log(`[vision] ${s.ctx.dockId}: change-gate = SEMANTIC (DINOv2 embedding)`);
      else console.error(`[vision] ${s.ctx.dockId}: change-gate = PIXEL (DEGRADED — embed model unavailable)`);
    });
    while (streams.has(streamId)) {
      let trigger: string | null = 'first-look';
      if ((s.lastEmb || s.lastSig) && !s.busy) {
        const jpeg = getFrame(s.ctx.streamId);
        // Ask the active gate whether the CONTENT changed since the last analyzed frame.
        // Preferred: the SEMANTIC gate (embedding distance) — robust to the lighting/
        // compression flicker that false-fired pixels; verified static ~0.006-0.02 vs a
        // person entering 0.25-0.53. Fallback: the pixel signature + learned noise floor,
        // used only when the embedder is unavailable (VISION_EMBED_GATE=0 / model missing).
        const probe = s.lastEmb ? await embedChanged(s, jpeg) : null;
        const changed = probe ? probe.trigger : (s.lastEmb ? null : pixelChanged(s, jpeg));
        const probeEmb = probe?.emb ?? null;
        // RECENT-ANALYSIS CACHE — checked BEFORE suppression: the view changed, but is it a
        // view we JUST described (the head swept back to the staircase we saw 8 s ago)? Reuse
        // that description — even WHILE MOVING, because "returning to a known view" is exactly
        // the case that suppression would otherwise just defer. Reuse is cheap + safe (tight
        // distance + short TTL), and strictly better than deferring when we already know the view.
        if (changed && probeEmb) {
          const hit = reuseFromCache(s, probeEmb);
          if (EMBED_DEBUG) {
            const dists = (s.recent ?? []).map((e) => embedDistance(probeEmb, e.emb).toFixed(3)).join(',');
            console.log(`[vision] ${s.ctx.dockId} cache-check: ${s.recent?.length ?? 0} entries [d=${dists}] thr=${REUSE_DIST} → ${hit ? 'HIT' : 'miss'}`);
          }
          if (hit) {
            if (EMBED_DEBUG) console.log(`[vision] ${s.ctx.dockId} REUSE (d=${hit.dist.toFixed(3)}): ${hit.text.slice(0, 50)}`);
            commitReused(s, hit, probeEmb, jpeg!.toString('base64'));  // probeEmb set ⇒ jpeg was non-null
            s.skippedProbes++; await sleep(PROBE_MS); continue;
          }
        }
        // SELF-MOTION SUPPRESSION: a change to a view we DON'T know, while the head pans, is
        // most likely the view sliding because WE moved — DEFER (don't wake the VLM), let the
        // head settle, re-probe next tick. A deferral, not a cache. (Cache already handled the
        // known-view case above; this only catches genuinely-new views mid-motion.)
        if (SELFMOTION_SUPPRESS && changed && cameraMoving?.(s.ctx.dockId)) {
          if (EMBED_DEBUG) console.log(`[vision] ${s.ctx.dockId} defer: ${changed} but head is moving (self-motion)`);
          s.skippedProbes++; await sleep(PROBE_MS); continue;
        }
        // changed === null → couldn't probe (no frame) → fail OPEN (look).
        if (changed === null) trigger = 'no-probe-frame';
        else if (changed) trigger = changed;
        // Nothing changed — but audio near the blind spot, or the slow-drift heartbeat,
        // can still warrant a look. Shared across both gates so the policy lives once.
        else if (Date.now() - (s.lastSenseWakeAt ?? 0) >= SENSE_WAKE_COOLDOWN_MS && senseWake(s)) {
          trigger = 'sense-wake'; s.lastSenseWakeAt = Date.now();
        } else if (Date.now() - s.lastAnalyzedAt >= REFRESH_MS) trigger = 'heartbeat';
        else trigger = null;
        if (!trigger) { s.skippedProbes++; await sleep(PROBE_MS); continue; }
      }
      if (trigger) {
        s.lastTrigger = trigger;
        const committed = await captureOnce(s, WINDOW_FRAMES, FRAME_GAP_MS);
        if (!committed) { await sleep(500); continue; } // stream not live yet / inference failed
        // POST-INFERENCE RE-PROBE: the loop was BLIND for the ~5s inference (busy-gated). A
        // visual-only event that started AND ended inside that window is missed by the next
        // ordinary probe (it compares the settled scene against the now-updated anchor). So
        // right after committing, compare a FRESH frame against the just-set anchor: if it
        // already moved past threshold, something happened during/just-after the inference —
        // loop IMMEDIATELY (skip the PROBE_MS nap) so it's analyzed now, not PROBE_MS later.
        if (REPROBE_AFTER_INFERENCE && s.lastEmb) {
          const jpeg = getFrame(s.ctx.streamId);
          const emb = jpeg ? await embedFrame(jpeg) : null;
          if (emb) {
            const d = embedDistance(emb, s.lastEmb);
            if (d >= EMBED_THRESHOLD) {
              if (EMBED_DEBUG) console.log(`[vision] ${s.ctx.dockId} post-inference reprobe: d=${d.toFixed(3)} ≥ ${EMBED_THRESHOLD} → re-fire now`);
              continue;                    // don't sleep — re-enter the loop, gate will trigger
            }
          }
        }
      } else {
        s.skippedProbes++;               // scene unchanged → no GPU this round
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
