/**
 * SpeechGate — synchronizes body motion with the phone's AUDIO clock
 * (docs/decision-traces/motion-speech-timing.md).
 *
 * The problem (2026-07-16 demo): `move` executes in ~5ms while TTS takes
 * seconds, so the body danced BEFORE "Check this out!" was heard, and the
 * announcement droned on after the dance ended. The LLM's part ordering
 * (text → tool call) carries its intent, but execution ignored it.
 *
 * The gate gives the move tool three awaitable barriers on the signals the
 * phone already sends:
 *
 *   waitQuiet()            "everything I said so far has been SPOKEN" —
 *                          resolves on the next tts-end (speech-status
 *                          speaking:false = the phone's TTS queue drained).
 *   waitAnchor(seq)        "the sentence carrying the [move] tag just started
 *                          PLAYING" — resolves on utterance-active (new app
 *                          builds ack playback start of tagged sentences; the
 *                          mood-active ack feeds this too).
 *   (both)                 fall back to a TTS-length timeout, so a lost frame
 *                          or an old app build delays a move, never wedges it.
 *
 * One gate per session, reset per turn. cancel() resolves every waiter with
 * 'cancelled' — a barge-in must not leave a dance queued to fire mid-apology.
 */

export type GateOutcome =
  | 'immediate'   // nothing to wait for — no speech in flight
  | 'spoken'      // the anchor sentence started playing (the precise signal)
  | 'quiet'       // the speech lane drained (the after-speech signal)
  | 'timeout'     // no signal within the TTS-length estimate — proceed anyway
  | 'cancelled';  // turn cancelled while waiting — caller must NOT move

interface Waiter {
  kind: 'quiet' | 'anchor';
  /** anchor waiters: the speak-frame seq whose playback start releases them. */
  seq?: number;
  resolve: (o: GateOutcome) => void;
  timer: NodeJS.Timeout;
}

/** ~chars/ms of phone TTS speech, for the fallback timeout: generous (slow
 *  voices, pauses) because the timeout only bites when signals are LOST. */
const TTS_MS_PER_CHAR = 90;
const TIMEOUT_FLOOR_MS = 4_000;
const TIMEOUT_CAP_MS = 30_000;

export class SpeechGate {
  #waiters: Waiter[] = [];
  /** chars sent to the voice since the lane last went quiet (timeout sizing). */
  #unspokenChars = 0;
  /** highest speak-frame seq the phone reported as started playing. */
  #playedSeq = -1;
  /** the latest [move]-tagged sentence's seq, not yet consumed by a move call. */
  #anchorSeq: number | undefined;

  /** #speak sent a sentence to the phone. */
  noteSent(chars: number): void {
    this.#unspokenChars += chars;
  }

  /** #speak extracted a [move] tag riding sentence `seq`. */
  noteAnchor(seq: number): void {
    this.#anchorSeq = seq;
  }

  /** The phone reported an utterance started PLAYING (utterance-active /
   *  mood-active). Releases anchor waiters at or before this seq. */
  noteUtteranceActive(seq: number): void {
    this.#playedSeq = Math.max(this.#playedSeq, seq);
    this.#resolveWhere((w) => w.kind === 'anchor' && w.seq != null && w.seq <= this.#playedSeq, 'spoken');
  }

  /** The phone's TTS queue drained (speech-status speaking:false): everything
   *  sent so far has been spoken. Releases every waiter. */
  noteQuiet(): void {
    this.#unspokenChars = 0;
    this.#resolveWhere(() => true, 'quiet');
  }

  /** Consume the pending [move] anchor (one move per tag). */
  takeAnchor(): number | undefined {
    const seq = this.#anchorSeq;
    this.#anchorSeq = undefined;
    return seq;
  }

  /** Wait until the speech sent so far has been fully spoken. Immediate when
   *  nothing is in flight. */
  waitQuiet(): Promise<GateOutcome> {
    if (this.#unspokenChars === 0) return Promise.resolve('immediate');
    return this.#wait({ kind: 'quiet' });
  }

  /** Wait until sentence `seq` starts playing (its [move] tag's moment). */
  waitAnchor(seq: number): Promise<GateOutcome> {
    if (this.#playedSeq >= seq) return Promise.resolve('spoken');
    return this.#wait({ kind: 'anchor', seq });
  }

  /** Turn start: forget the previous turn's state (a stale anchor must not
   *  gate the next turn's move). Waiters, if any survived, resolve cancelled. */
  reset(): void {
    this.cancel();
    this.#unspokenChars = 0;
    this.#playedSeq = -1;
    this.#anchorSeq = undefined;
  }

  /** Turn cancelled (barge-in / tap / timeout): release everyone as
   *  'cancelled' so no queued motion fires into the interruption. */
  cancel(): void {
    this.#resolveWhere(() => true, 'cancelled');
  }

  #wait(w: Omit<Waiter, 'resolve' | 'timer'>): Promise<GateOutcome> {
    return new Promise<GateOutcome>((resolve) => {
      const ms = Math.min(Math.max(this.#unspokenChars * TTS_MS_PER_CHAR, TIMEOUT_FLOOR_MS), TIMEOUT_CAP_MS);
      const waiter: Waiter = {
        ...w,
        resolve,
        timer: setTimeout(() => {
          this.#waiters = this.#waiters.filter((x) => x !== waiter);
          resolve('timeout');
        }, ms),
      };
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  #resolveWhere(match: (w: Waiter) => boolean, outcome: GateOutcome): void {
    const [hit, rest] = [this.#waiters.filter(match), this.#waiters.filter((w) => !match(w))];
    this.#waiters = rest;
    for (const w of hit) {
      clearTimeout(w.timer);
      w.resolve(outcome);
    }
  }
}
