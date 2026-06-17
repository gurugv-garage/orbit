/**
 * FaceRecognizer — wraps @vladmandic/face-api: loads the bundled models once,
 * and turns a decoded RGB frame (or an encoded image buffer) into the most
 * prominent face's 128-d descriptor. Pairs with the Gallery for identity match.
 *
 * tfjs-node runs on CPU (native `tensorflow` backend). Detection + embedding of
 * one frame is tens of ms — fine at the ~1 fps recognition cadence, but it still
 * runs on whatever thread calls it, so the processor invokes it off the main loop
 * (worker_thread) or rate-limits hard.
 */

import * as tf from '@tensorflow/tfjs-node';
import * as faceapi from '@vladmandic/face-api';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODELS_DIR = `${require('node:path').dirname(require.resolve('@vladmandic/face-api'))}/../model`;

let loaded = false;

/** Load the bundled detector + landmark + recognition + EXPRESSION nets once. */
export async function loadFaceModels(): Promise<void> {
  if (loaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceExpressionNet.loadFromDisk(MODELS_DIR); // emotions (bundled)
  loaded = true;
}

/**
 * The most prominent face's 128-d descriptor for an image, or null if no face.
 * @param input a 3-channel uint8 RGB tensor [h,w,3], or an encoded image Buffer
 *   (jpg/png) which we decode with tfjs-node.
 */
export async function describeFace(input: tf.Tensor3D | Buffer): Promise<number[] | null> {
  if (!loaded) await loadFaceModels();
  const tensor = Buffer.isBuffer(input)
    ? (tf.node.decodeImage(input, 3) as tf.Tensor3D)
    : input;
  try {
    // Lower minConfidence (default 0.5): our frames are small (320×240), often
    // at an angle or in poor light, so the detector needs to be more lenient to
    // find a face at all. 0.2 catches harder faces; a false-detect just yields a
    // non-matching descriptor (rejected by the gallery threshold), so it's safe.
    const det = await faceapi
      .detectSingleFace(
        tensor as unknown as faceapi.TNetInput,
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.2 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptor();
    return det ? Array.from(det.descriptor) : null;
  } finally {
    if (Buffer.isBuffer(input)) tensor.dispose(); // only dispose what we created
  }
}

/** One detected face: its descriptor + where it sits in the frame (for "left/right"). */
export interface DetectedFace {
  descriptor: number[];
  /** normalized box center, 0..1 (x: 0=left,1=right; y: 0=top,1=bottom). */
  cx: number;
  cy: number;
  /** normalized bounding box, 0..1 (x,y = top-left; w,h = size). */
  box: { x: number; y: number; w: number; h: number };
  score: number;
  /** top expression + full distribution (neutral/happy/sad/angry/surprised/…). */
  expression?: { top: string; score: number; all: Record<string, number> };
  /** mouth openness 0..1 (inner-lip gap / face height) — for active-speaker. */
  mouthOpen?: number;
}

/** Mouth openness from the 68-pt landmarks: inner-lip vertical gap, normalized by
 *  face height. ~0 = closed, higher = open/speaking. */
function mouthOpenness(landmarks: faceapi.FaceLandmarks68, faceH: number): number {
  const m = landmarks.getMouth(); // 20 points; inner lip = indices 13..19
  // inner top lip ~ pt 14 (index 13), inner bottom ~ pt 18 (index 17)
  const top = m[13], bottom = m[17];
  if (!top || !bottom || !faceH) return 0;
  return Math.min(1, Math.abs(bottom.y - top.y) / faceH);
}

/**
 * ALL faces in the image, each with its own descriptor + frame position. Same
 * detector/threshold as {@link describeFace}; the only difference is detectAll
 * vs detectSingle. Returned left-to-right (by box center x) so the caller can
 * say "Guru on the left, Shweta on the right" without re-sorting.
 */
export async function describeAllFaces(input: tf.Tensor3D | Buffer): Promise<DetectedFace[]> {
  if (!loaded) await loadFaceModels();
  const tensor = Buffer.isBuffer(input)
    ? (tf.node.decodeImage(input, 3) as tf.Tensor3D)
    : input;
  try {
    const dets = await faceapi
      .detectAllFaces(
        tensor as unknown as faceapi.TNetInput,
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.2 }),
      )
      .withFaceLandmarks()
      .withFaceExpressions()
      .withFaceDescriptors();
    const [, , w, h] = [0, 0, (tensor as tf.Tensor3D).shape[1], (tensor as tf.Tensor3D).shape[0]];
    return dets
      .map((d) => {
        const b = d.detection.box;
        const W = w || 1, H = h || 1;
        const exprAll = d.expressions as unknown as Record<string, number>;
        const top = Object.entries(exprAll).reduce((a, c) => (c[1] > a[1] ? c : a), ['neutral', 0]);
        return {
          descriptor: Array.from(d.descriptor),
          cx: (b.x + b.width / 2) / W,
          cy: (b.y + b.height / 2) / H,
          box: { x: b.x / W, y: b.y / H, w: b.width / W, h: b.height / H },
          score: d.detection.score,
          expression: { top: top[0], score: top[1], all: exprAll },
          mouthOpen: mouthOpenness(d.landmarks, b.height),
        };
      })
      .sort((a, b) => a.cx - b.cx);
  } finally {
    if (Buffer.isBuffer(input)) tensor.dispose();
  }
}
