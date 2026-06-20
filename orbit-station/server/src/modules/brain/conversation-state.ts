/**
 * ConversationState — the SINGLE owner of a dock's conversational mode.
 *
 * Replaces the three fragmented owners (the session's loose #speaking/#listening
 * flags, the separate addressedLatch Map, and the phone's arbiter acting as a
 * second brain) with one station-side state machine. The phone reports raw events
 * (tap, utterance, vad, tts edges, connect); this decides the mode + whether an
 * utterance is addressed. (docs/findings/conversation-state-design.md +
 * conversation-state-test-cases.md)
 *
 *   IDLE ──tap──▶ LISTENING ──addressed utterance──▶ THINKING ──reply──▶ SPEAKING
 *    ▲   ◀─tap────┘ (no-speech timeout → IDLE)                            │ tts end
 *    │             ▲                                                      ▼
 *    └─ followup expires ◀──────────────── FOLLOWUP ◀──────────────────────┘
 *                         (auto re-listen FOLLOWUP_MS; VAD extends; tap toggles off)
 *
 * "Addressed" is not a separate concept: an utterance is addressed iff a listening
 * window (LISTENING or FOLLOWUP) is open when it ends (with GRACE for the tap↔
 * transcript ordering race). Pure + deterministic — the caller passes `now` (ms).
 * No I/O, no timers; the session ticks it. Unit-tested in conversation-state.test.ts.
 */

export type ConvMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'followup';

/** Tunable timings (ms), centralized + documented so they're easy to play with. */
export const ConvCfg = {
  /** A tap with no speech yet drops back to idle after this (the ack timeout). */
  LISTEN_MS: Number(process.env.CONV_LISTEN_MS ?? 8_000),
  /** Auto re-listen window after a reply (hands-free follow-up). */
  FOLLOWUP_MS: Number(process.env.CONV_FOLLOWUP_MS ?? 5_000),
  /** VAD activity during listening/followup pushes the window out this far. */
  VAD_EXTEND_MS: Number(process.env.CONV_VAD_EXTEND_MS ?? 4_000),
  /** Grace for the tap↔utterance ordering race: an utterance ending this long
   *  before `now` (while a window is open) still counts (finish, then tap). */
  GRACE_MS: Number(process.env.CONV_GRACE_MS ?? 2_500),
  /** SPEAKING safety cap: if a tts-end is lost, SPEAKING can't wedge forever.
   *  Reconcile-on-connect is the primary recovery; this is the backstop. */
  SPEAK_MAX_MS: Number(process.env.CONV_SPEAK_MAX_MS ?? 30_000),
  /** A face arriving in view opens a brief low-priority listen window. */
  FACE_ARRIVAL_MS: Number(process.env.CONV_FACE_ARRIVAL_MS ?? 5_000),
};

/** A state transition, emitted for observability + the phone renderer. */
export interface ConvTransition {
  from: ConvMode;
  to: ConvMode;
  reason: string;
  at: number;
}

/** Why a listening window is open — drives priority (a low-priority OFF signal
 *  like face-leave can't cancel a higher one like a tap or follow-up). */
export type WindowSource = 'face' | 'tap' | 'followup';
const SRC_PRIORITY: Record<WindowSource, number> = { face: 10, followup: 50, tap: 100 };

export class ConversationState {
  #mode: ConvMode = 'idle';
  #windowUntil = 0; // LISTENING/FOLLOWUP expiry (ms), or 0
  #windowSrc: WindowSource = 'tap'; // why the current window is open (priority)
  #speakUntil = 0;  // SPEAKING safety expiry (ms), or 0
  #onTransition?: (t: ConvTransition) => void;

  constructor(onTransition?: (t: ConvTransition) => void) {
    this.#onTransition = onTransition;
  }

  // ── reads (prune first so expiries are reflected) ─────────────────────────

  mode(now: number): ConvMode { this.#prune(now); return this.#mode; }
  isListening(now: number): boolean { const m = this.mode(now); return m === 'listening' || m === 'followup'; }
  /** ms until the current window/speak expiry (for the /conversation probe), or 0. */
  msToExpiry(now: number): number {
    this.#prune(now);
    const until = this.#mode === 'speaking' ? this.#speakUntil : this.#windowUntil;
    return until ? Math.max(0, until - now) : 0;
  }
  snapshot(now: number): { mode: ConvMode; windowUntil: number; speakUntil: number; msToExpiry: number } {
    this.#prune(now);
    return { mode: this.#mode, windowUntil: this.#windowUntil, speakUntil: this.#speakUntil, msToExpiry: this.msToExpiry(now) };
  }

  // ── events in ─────────────────────────────────────────────────────────────

  /** Tap is a TOGGLE: open an explicit LISTENING window when idle/followup, or
   *  close listening when already listening/followup. (D1) */
  tap(now: number): void {
    this.#prune(now);
    if (this.#mode === 'listening' || this.#mode === 'followup') {
      this.#set('idle', now, 'tap-off'); this.#windowUntil = 0;
    } else if (this.#mode === 'idle') {
      this.#openWindow('tap', now + ConvCfg.LISTEN_MS, now, 'tap');
    }
    // during thinking/speaking a tap is ignored (the turn owns the lane).
  }

  /** A NEW face arrived in view → a low-priority listen window (D3): yields to an
   *  active tap/followup (won't override a higher window), opens one when idle. */
  faceArrival(now: number): void {
    this.#prune(now);
    if (this.#mode === 'idle') this.#openWindow('face', now + ConvCfg.FACE_ARRIVAL_MS, now, 'face-arrival');
    // if already listening/followup/thinking/speaking → ignore (don't downgrade).
  }

  /** A face LEFT view → release ONLY a low-priority face window. It must NOT
   *  cancel a tap or follow-up (D2: a glance away doesn't end your conversation). */
  faceLeft(now: number): void {
    this.#prune(now);
    if ((this.#mode === 'listening' || this.#mode === 'followup') && this.#windowSrc === 'face') {
      this.#windowUntil = 0;
      this.#set('idle', now, 'face-left');
    }
  }

  /** A turn started (addressed utterance / self / task) → THINKING. Clears both
   *  windows: from listening/followup (normal) OR from speaking (a barge-in
   *  supersede starts a new turn mid-TTS). */
  turnStart(now: number): void {
    this.#prune(now);
    this.#windowUntil = 0;
    this.#speakUntil = 0;
    this.#set('thinking', now, 'turn-start');
  }

  /** TTS started playing the reply → SPEAKING (bounded by SPEAK_MAX_MS). */
  speakStart(now: number): void {
    this.#speakUntil = now + ConvCfg.SPEAK_MAX_MS;
    this.#set('speaking', now, 'tts-start');
  }

  /** TTS finished → auto re-listen (FOLLOWUP, high priority — survives face-leave). */
  speakEnd(now: number): void {
    this.#speakUntil = 0;
    this.#windowSrc = 'followup';
    this.#windowUntil = now + ConvCfg.FOLLOWUP_MS;
    this.#set('followup', now, 'tts-end');
  }

  /** VAD activity — extend an open listening/followup window so a slow speaker
   *  isn't cut off. No-op if no window is open. */
  vadActivity(now: number): void {
    this.#prune(now);
    if (this.#mode === 'listening' || this.#mode === 'followup') {
      this.#windowUntil = Math.max(this.#windowUntil, now + ConvCfg.VAD_EXTEND_MS);
    }
  }

  /**
   * A finalized utterance that ended at `endedAt`. Returns whether it's ADDRESSED.
   * Addressed iff a listening/followup window is open and the utterance ended
   * at/after `now - GRACE` (the ordering race). Overheard utterances leave the
   * state untouched.
   *
   * CONSUMES the window when addressed → moves straight to THINKING. This is
   * atomic on purpose: the caller runs the turn ASYNC (handleTurnRequest), so if
   * we left the window open a SECOND rapid utterance in that gap would double-fire
   * (a spurious supersede). One window → one turn, enforced here, not by the caller.
   */
  utteranceEnded(endedAt: number, now: number): boolean {
    this.#prune(now);
    if (this.#mode !== 'listening' && this.#mode !== 'followup') return false;
    if (endedAt < now - ConvCfg.GRACE_MS) return false;
    this.#windowUntil = 0;
    this.#set('thinking', now, 'addressed-utterance');
    return true;
  }

  /** The phone (re)connected → reconcile to a clean slate (a fresh phone is idle,
   *  not speaking). Clears a stale SPEAKING a lost tts-end would otherwise wedge. */
  reconcileConnected(now: number): void {
    this.#speakUntil = 0; this.#windowUntil = 0;
    this.#set('idle', now, 'reconnect');
  }

  /** Advance time: fire any pending expiry transitions (followup/listen window,
   *  speak safety) WITHOUT a read/event. The session calls this on a timer so the
   *  phone gets beep-off/idle promptly, not only when the next event happens to
   *  prune. Pure: just prunes at `now`. */
  tick(now: number): void { this.#prune(now); }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Drop expired windows → the correct mode (called before every read/event). */
  #prune(now: number): void {
    if (this.#mode === 'speaking' && this.#speakUntil && now >= this.#speakUntil) {
      // tts-end lost → behave as if speech ended (bounded recovery).
      this.#speakUntil = 0;
      this.#windowUntil = now + ConvCfg.FOLLOWUP_MS;
      this.#set('followup', now, 'speak-timeout');
    }
    if ((this.#mode === 'listening' || this.#mode === 'followup')
        && this.#windowUntil && now >= this.#windowUntil) {
      this.#windowUntil = 0;
      this.#set('idle', now, 'window-timeout');
    }
  }

  /** Open a listening window of a given source (priority) → listening. */
  #openWindow(src: WindowSource, until: number, now: number, reason: string): void {
    this.#windowSrc = src;
    this.#windowUntil = until;
    this.#set('listening', now, reason);
  }

  #set(to: ConvMode, at: number, reason: string): void {
    if (to === this.#mode) return;
    const from = this.#mode;
    this.#mode = to;
    this.#onTransition?.({ from, to, reason, at });
  }
}
// keep SRC_PRIORITY referenced (priority is encoded in faceLeft's source check;
// exported map is available for future multi-source arbitration if needed).
void SRC_PRIORITY;
