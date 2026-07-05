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
const BASE =
  'In one short sentence, describe what is happening. ' +
  'FIRST check whether any person is actually visible. If NO person is clearly visible, ' +
  'start with "No one is visible" and add a few words about anything notable or changed. ' +
  'If a person IS clearly visible, describe their action and posture and any object they ' +
  'are clearly holding or using — use "they"/"the person"; do not guess gender, age, or name. ' +
  'Look at the object ITSELF and name what it actually is; if you are not sure what ' +
  'the object is, say "an object" rather than guessing a common one. ' +
  'Do NOT default to "laptop" or "phone" — only say so if you clearly see one. ' +
  'State only what is clearly visible — do NOT invent people, actions, or details.';
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
