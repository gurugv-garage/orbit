/**
 * Brain tuning constants — knobs that are NOT live-tunable ops settings.
 *
 * These used to be config-registry entries, but they're tuning/dev values that
 * change rarely and never at runtime by an operator, so they don't belong in
 * the config tab (which is for live-tunable ops: model, persona, grants,
 * gestures, …). Change them here + redeploy.
 *
 * (brainThinkingLevel and brainTurnTimeoutMs STAY in config — they're wired to
 * live controls in the Brain console view.)
 */

/** Hard cap on transcript length before sanitizeHistory trims whole turns from
 *  the front (at a user-message boundary). */
export const MAX_HISTORY_MESSAGES = 48;

/** A brain session closes after this many minutes without a turn (then compacts
 *  to a summary; the next turn opens fresh). */
export const SESSION_IDLE_MIN = 30;

/** Vision gate: attach the camera frame only on vision-intent turns. Small
 *  vision models fixate on an always-present image and ignore movement
 *  commands, so gating it on intent keeps non-vision turns clean. */
export const VISION_GATE = true;
