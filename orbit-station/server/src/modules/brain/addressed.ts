/**
 * Addressed-latch correlator — A1.2 of the always-on-mic shift
 * (docs/perception-to-brain.md, "A1 — the always-on-mic shift").
 *
 * With an always-on mic the station hears EVERY utterance; only some are meant
 * for the agent. A **tap** on the dock marks intent ("I'm talking TO you"). This
 * pure module decides, for a stream of transcribed utterances + tap times, which
 * utterances become agent turns.
 *
 * The model (decided): **latch until sentence-end.**
 *   - a tap sets the dock `addressed`;
 *   - every FINAL utterance whose window qualifies while addressed → a turn;
 *   - `addressed` auto-clears at that utterance's VAD endpoint (sentence-end).
 *
 * "Qualifies" handles both natural cases without extra phone state:
 *   - **tap-then-speak** — the utterance STARTS at/after the tap → addressed.
 *   - **tap-mid-sentence** — the utterance was already in progress when the tap
 *     landed (started before the tap but ends at/after it) → still addressed, so
 *     a tap partway through a sentence still captures that whole sentence.
 *   - an utterance that ENDED before the tap is NOT addressed (it's the past).
 *
 * Pure + deterministic: same inputs → same decision. No clock, no I/O — the
 * caller passes the relevant times. Unit-tested exhaustively in addressed.test.ts.
 */

/** A completed utterance's window (ms epoch), from the STT VAD endpointer. */
export interface Utterance {
  /** when speech began (first voiced frame). */
  startedAt: number;
  /** when the VAD endpoint fired (sentence-end). */
  endedAt: number;
}

/**
 * The latch's view of "am I addressed", carried by the caller between calls.
 * `tapAt` is the most recent tap time (ms) that hasn't yet been consumed by an
 * utterance's endpoint; null = not addressed.
 */
export interface AddressedLatch {
  tapAt: number | null;
}

/** A fresh, un-addressed latch. */
export function newLatch(): AddressedLatch {
  return { tapAt: null };
}

/**
 * Grace window (ms) bridging the tap↔utterance ORDERING RACE. The tap frame
 * (WS) and the utterance transcript (perception onFinal) reach the brain via
 * independent async paths, and a person naturally taps a beat AFTER they finish
 * the sentence ("…the sun? *tap*"). So an utterance that ended slightly BEFORE
 * the tap is still the addressed one — not "the past". Without this, that common
 * case is dropped (the intermittent "sometimes my speech doesn't register").
 */
export const TAP_GRACE_MS = 2_500;

/** Record a tap at `at` (ms) — the dock is now addressed until the next endpoint. */
export function tap(latch: AddressedLatch, at: number): AddressedLatch {
  // Keep the LATER tap if two arrive before an utterance consumes them.
  return { tapAt: latch.tapAt == null ? at : Math.max(latch.tapAt, at) };
}

/**
 * Decide whether a just-finalized `utterance` is addressed, given the current
 * latch. Returns the decision AND the next latch state (the latch clears on a
 * consumed utterance — sentence-end ends the addressed window).
 *
 * Addressed iff there's a live tap AND the utterance ended at/after the tap, OR
 * within `graceMs` BEFORE it (the tap-just-after-speaking / frame-ordering race).
 * An utterance older than that is genuinely the past — keep the latch armed for
 * the next sentence (the tap was meant for something still to come).
 */
export function decideAddressed(
  latch: AddressedLatch,
  utterance: Utterance,
  graceMs = TAP_GRACE_MS,
): { addressed: boolean; next: AddressedLatch } {
  const t = latch.tapAt;
  if (t == null) return { addressed: false, next: latch };

  // Too old even with grace → the tap is for a later sentence; stay armed.
  if (utterance.endedAt < t - graceMs) return { addressed: false, next: latch };

  // The utterance ends around or after the tap → addressed. Consume the latch.
  return { addressed: true, next: { tapAt: null } };
}
