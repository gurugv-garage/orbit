/**
 * Steerable vision instruction — the prompt the always-on vision processor
 * (vision-watch) sends moondream each frame. A built-in BASE plus a live-settable
 * EXTRA the console (and later a task) can append/modify on the running stream.
 *
 * Shared singleton so the REST endpoint (POST /api/perception/instruction) and
 * the processor read/write the same value without a bus round-trip. Per the
 * perception pyramid (docs/PERCEPTION-PYRAMID.md) the vision instruction "could
 * borrow instructions from an ongoing task"; this is the slot that gets steered.
 */

// moondream2 on a 320x240 frame WILL pad with invented details no matter the
// prompt (it's the accuracy gap vs md3 — see models/moondream/FINDINGS.md). Long
// "do not guess / say if unclear" prompts make it emit EMPTY (it can't follow
// meta-instructions); "describe what you see" maximizes confabulation. Tested on
// the fixtures, a plain "What is in this image?" is the most grounded short
// prompt that still answers — it gets the core facts right and pads least.
// For higher fidelity, point VISION_WATCH_MODEL at an md3 sidecar.
const BASE = 'What is in this image? Mention any person and their posture.';

let extra = '';

/** The full instruction sent to the model = base + any steered extra.
 *
 *  moondream returns EMPTY on closed/imperative prompts ("tell me when he holds a
 *  cup", "is X happening?"). So we never append the steer as a command — we fold it
 *  into the open describe request as a focus hint, which keeps moondream answering
 *  while biasing its description toward what you care about. The downstream code can
 *  then match the steer terms against the prose. */
export function visionInstruction(): string {
  if (!extra) return BASE;
  // Weave the steer into the describe request as an "including …" clause — tested
  // to keep moondream answering where "Pay attention to: <steer>" makes it emit
  // empty. Strip a leading "tell me / watch for / flag" so "tell me when he holds a
  // cup" reads naturally as "…, including when he holds a cup."
  const focus = extra.replace(/^(tell me( when| if)?|watch for|flag( if| when)?|notify me( if| when)?|alert me( if| when)?|let me know( if| when)?)\s+/i, '').trim();
  return `Describe this image, including ${focus}. Mention any person and their posture.`;
}

export function getVisionExtra(): string {
  return extra;
}

/** Steer the running stream: set/replace the extra instruction (empty clears). */
export function setVisionExtra(s: string): void {
  extra = (s ?? '').trim();
}

export function visionBase(): string {
  return BASE;
}
