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
const BASE =
  'In one short sentence, describe what the person is doing — their action and ' +
  'posture — and any object they are clearly holding or using (e.g. "typing on a ' +
  'laptop", "drinking from a cup", "standing and looking at the screen"). ' +
  'Use "they"/"the person"; do not guess gender, age, or name. State only what is ' +
  'clearly visible — do NOT describe the background or invent details or other people.';

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
