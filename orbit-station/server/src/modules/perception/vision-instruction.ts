/**
 * Steerable vision instruction — the prompt the vision-snapshot processor sends
 * qwen for each window. A built-in BASE plus a live-settable EXTRA the console
 * (and later a task) can append/modify on the running stream.
 *
 * Shared singleton so the REST endpoint (POST /api/perception/instruction) and the
 * processor read/write the same value without a bus round-trip.
 */

// qwen follows instructions (unlike moondream), so the BASE actively suppresses
// hallucination: describe only what's clearly visible, do NOT guess gender /
// identity / details. Identity (names) is supplied separately by face recognition
// and fused in by the processor — qwen must NOT invent it.
// Sweet spot (tested): captures the actual ACTION + any held object — the "who did
// what" signal — without the fabricated rooms/people/clothing the loose prompt
// produced. Too-strict prompts collapse to "the person is present" (useless).
// The old BASE PRESUPPOSED a person ("describe what the person is doing") — shown an
// empty room, the 3B model obliged the presupposition and INVENTED one ("the person is
// standing holding a black object", every window, from a hanging strap; seen live
// 2026-07-05 with identity simultaneously reporting "no one in view"). The prompt must
// first allow "nobody here".
// SIMPLE by hard-won lesson (2026-07-09): an elaborate multi-rule prompt (forced "No one
// visible —" opener + a two-line DESCRIPTION/CHANGE format + a fed-back previous
// description) POISONED the 3B model — it echoed a stale "None visible" while a person was
// plainly on the stairs. The SAME frames with this short prompt caught "a person ascending
// a staircase" 3/3. A small model needs a small ask: describe what you see, don't invent.
const BASE =
  'In one short sentence, say what is happening across these frames. If a person is ' +
  'visible, describe what they are doing (use "they"/"the person"; do not guess gender, ' +
  'age, or name). If truly no person is present, briefly describe the scene. Name objects ' +
  'as what they actually are; if unsure, say "an object". Describe only what is clearly ' +
  'visible — do not invent people, actions, or details.';
// SINGLE-frame variant: the window-dedup collapsed a static window to one frame (nothing
// moved), so asking "what is happening ACROSS these frames" about one still image is an odd
// ask. Same anti-hallucination rules, phrased for a single image. (2026-07-10)
const BASE_SINGLE =
  'In one short sentence, describe this single frame. If a person is visible, describe what ' +
  'they are doing (use "they"/"the person"; do not guess gender, age, or name). If truly no ' +
  'person is present, briefly describe the scene. Name objects as what they actually are; if ' +
  'unsure, say "an object". Describe only what is clearly visible — do not invent people, ' +
  'actions, or details.';
// NOTE: the examples ("typing on a laptop"…) were removed deliberately. qwen2.5-VL is
// small and ANCHORS on the first in-prompt example when a 320×240 frame is ambiguous —
// it was reading a held-up mug/cup as "typing on a laptop" (the seeded example) because
// the desk scene is its strong prior. Resolution (≥512px) is the real fix for the
// flicker (see memory: perception-hallucination-knobs); this removes the prompt's
// contribution to the wrong fallback.

let extra = '';

/** The full instruction sent to the model = base + any steered extra.
 *
 *  moondream returns EMPTY on closed/imperative prompts ("tell me when he holds a
 *  cup", "is X happening?"). So we never append the steer as a command — we fold it
 *  into the open describe request as a focus hint, which keeps moondream answering
 *  while biasing its description toward what you care about. The downstream code can
 *  then match the steer terms against the prose. */
export function visionInstruction(mode: 'window' | 'single' = 'window'): string {
  const base = mode === 'single' ? BASE_SINGLE : BASE;
  if (!extra) return base;
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
