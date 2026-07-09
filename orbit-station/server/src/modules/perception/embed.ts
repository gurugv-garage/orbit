/**
 * embed — an in-process DINOv2-small image embedder (ONNX via onnxruntime-node), used
 * as the vision loop's SEMANTIC change-gate: a frame's 384-d embedding is compared to the
 * last analyzed frame's, and the expensive VLM only runs when they differ enough. This
 * replaces the hand-tuned pixel-signature gate (16x16 grayscale + per-cell noise floors)
 * that kept false-firing on a flickering light edge — an embedding is inherently robust to
 * lighting/compression jitter and fires on real content change.
 *
 * No sidecar: the model runs INSIDE the station (onnxruntime-node), ~100MB resident,
 * ~25ms/frame on CPU — negligible at the gate's ~1.5s probe cadence. The ONNX file
 * (models/embed/dinov2_vits14.onnx, 88MB) is exported once from torch (see
 * scripts/export-dino.py) and committed; there is no Python at runtime.
 *
 * tfjs (already a dep, used by the old gate) decodes+resizes the JPEG to the 224x224
 * ImageNet-normalized tensor the model wants.
 */
import * as tf from '@tensorflow/tfjs-node';
import * as ort from 'onnxruntime-node';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const MODEL_PATH = fileURLToPath(new URL('../../../models/embed/dinov2_vits14.onnx', import.meta.url));
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** The semantic (embedding) change-gate is now the DEFAULT (verified live 2026-07-09: static
 *  dim scene ~0.006-0.02, a person entering 0.25-0.53 — a clean 30-70× gap the pixel gate
 *  never achieved). Set VISION_EMBED_GATE=0 to force the legacy pixel gate. A failure is NOT
 *  silent: getSession() logs a loud ERROR and the loop announces the DEGRADED state, so a
 *  missing/unloadable model reads as an explicit "degraded to pixels", never a mystery
 *  vision-quality regression (that visibility was the whole point of the opt-in phase). */
export const EMBED_GATE_ENABLED = process.env.VISION_EMBED_GATE !== '0';

let session: ort.InferenceSession | null = null;
let loadState: 'unloaded' | 'ok' | 'failed' = 'unloaded';

/** Human status of the embed gate, for the health surface / Studio: is it enabled, and if
 *  so did the model actually load? Lets an operator SEE "requested but degraded to pixels"
 *  instead of silently getting worse gating. */
export function embedGateStatus(): { enabled: boolean; state: 'unloaded' | 'ok' | 'failed' } {
  return { enabled: EMBED_GATE_ENABLED, state: loadState };
}

/** Lazy-load the ONNX session once, ONLY when the gate is enabled. Returns null if
 *  disabled, or if the model is missing/unloadable — and in the FAILURE case it warns
 *  LOUDLY + repeatedly-suppressed-to-once, because "enabled but failed" is a degraded
 *  state the operator must know about (not a silent fallback). */
async function getSession(): Promise<ort.InferenceSession | null> {
  if (!EMBED_GATE_ENABLED) return null;               // VISION_EMBED_GATE=0 forces pixel gate
  if (session || loadState === 'failed') return session;
  if (!existsSync(MODEL_PATH)) {
    // Auto-export on first run (the 84MB ONNX is gitignored — deterministic from torch.hub,
    // so a fresh clone regenerates it once rather than bloating the repo). Best-effort: if
    // torch/onnx aren't installed the export fails and we degrade LOUDLY to pixels.
    console.log('[embed] DINOv2 ONNX not found — exporting once (scripts/export-dino.py)…');
    try {
      const { execFileSync } = await import('node:child_process');
      const script = fileURLToPath(new URL('../../../scripts/export-dino.py', import.meta.url));
      execFileSync(process.env.PERCEPTION_PYTHON ?? 'python3', [script], { stdio: 'inherit', timeout: 180_000 });
    } catch (err) {
      console.error(`[embed] ⚠️  auto-export FAILED (${String(err)}) — vision change-gate DEGRADED `
        + 'to the pixel path. Install torch+onnx and run scripts/export-dino.py, or set VISION_EMBED_GATE=0.');
      loadState = 'failed';
      return null;
    }
  }
  if (!existsSync(MODEL_PATH)) { loadState = 'failed'; return null; }
  try {
    session = await ort.InferenceSession.create(MODEL_PATH);
    loadState = 'ok';
    console.log('[embed] ✅ DINOv2-small ONNX loaded — SEMANTIC change-gate active');
    return session;
  } catch (err) {
    console.error(`[embed] ⚠️  VISION_EMBED_GATE=1 but DINOv2 ONNX FAILED to load: ${String(err)} — `
      + 'gate is DEGRADED to the pixel path.');
    loadState = 'failed';
    return null;
  }
}

/** JPEG → 224x224 ImageNet-normalized CHW Float32Array (the model's `img` input). tfjs
 *  handles decode + bilinear resize; the normalize + HWC→CHW is a plain loop. */
function preprocess(jpeg: Buffer): Float32Array {
  return tf.tidy(() => {
    const img = tf.node.decodeJpeg(jpeg, 3);                    // HxWx3 uint8
    const resized = tf.image.resizeBilinear(img as tf.Tensor3D, [224, 224]).div(255);
    const hwc = resized.dataSync() as Float32Array;            // 224*224*3, HWC
    const chw = new Float32Array(3 * 224 * 224);
    const HW = 224 * 224;
    for (let i = 0; i < HW; i++) {
      for (let c = 0; c < 3; c++) {
        chw[c * HW + i] = (hwc[i * 3 + c]! - MEAN[c]!) / STD[c]!;
      }
    }
    return chw;
  });
}

/** L2-normalized 384-d embedding of a JPEG, or null if the embedder is unavailable. */
export async function embedFrame(jpeg: Buffer): Promise<Float32Array | null> {
  const s = await getSession();
  if (!s) return null;
  try {
    const input = new ort.Tensor('float32', preprocess(jpeg), [1, 3, 224, 224]);
    const out = await s.run({ img: input });
    const emb = out.emb; if (!emb) return null;
    const raw = emb.data as Float32Array;
    let norm = 0;
    for (const v of raw) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    const unit = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) unit[i] = raw[i]! / norm;
    return unit;
  } catch (err) {
    console.warn(`[embed] inference failed: ${String(err)}`);
    return null;
  }
}

/** Cosine DISTANCE (0 = identical, up to 2) between two L2-normalized embeddings. */
export function embedDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return 1 - dot;
}

/** Is the embedder available (model present + loadable)? For the gate to decide whether
 *  to use the semantic path or fall back to pixels. */
export async function embedderReady(): Promise<boolean> {
  return (await getSession()) != null;
}
