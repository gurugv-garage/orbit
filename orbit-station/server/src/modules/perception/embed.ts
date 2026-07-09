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

let session: ort.InferenceSession | null = null;
let loadFailed = false;

/** Lazy-load the ONNX session once. Returns null if the model file is missing or ORT
 *  can't load it — callers fall back to the pixel gate, so a missing model never breaks
 *  perception. */
async function getSession(): Promise<ort.InferenceSession | null> {
  if (session || loadFailed) return session;
  if (!existsSync(MODEL_PATH)) {
    console.warn(`[embed] DINOv2 ONNX not found at ${MODEL_PATH} — change-gate falls back to pixels`);
    loadFailed = true;
    return null;
  }
  try {
    session = await ort.InferenceSession.create(MODEL_PATH);
    console.log('[embed] DINOv2-small ONNX loaded (in-process change-gate)');
    return session;
  } catch (err) {
    console.warn(`[embed] failed to load DINOv2 ONNX: ${String(err)} — falling back to pixels`);
    loadFailed = true;
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
