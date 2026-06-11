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

/** Load the bundled detector + landmark + recognition nets once. */
export async function loadFaceModels(): Promise<void> {
  if (loaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
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
