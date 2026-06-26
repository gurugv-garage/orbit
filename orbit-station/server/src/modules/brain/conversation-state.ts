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
  /** Auto re-listen window after a reply (hands-free follow-up). 8s — long enough
   *  for a natural pause-then-follow-up; VAD activity extends it further. (Was 5s;
   *  felt rushed.) Tune via CONV_FOLLOWUP_MS. */
  FOLLOWUP_MS: Number(process.env.CONV_FOLLOWUP_MS ?? 8_000),
  /** While VAD says you're TALKING, hold the window open this far out (re-pushed by the
   *  phone's VAD keepalive every ~0.8s). Large = no ceiling: talk as long as you want;
   *  only a vad-END (or a disconnect lapsing the keepalive) closes it. */
  VAD_HOLD_MS: Number(process.env.CONV_VAD_HOLD_MS ?? 30_000),
  /** After VAD says speech ENDED (a real ~1.5s silence on the phone), keep the window
   *  this much longer before committing — a short endpoint tail. */
  VAD_ENDPOINT_MS: Number(process.env.CONV_VAD_ENDPOINT_MS ?? 1_500),
  /** (legacy) fixed per-VAD extend — kept for back-compat / tests. */
  VAD_EXTEND_MS: Number(process.env.CONV_VAD_EXTEND_MS ?? 6_000),
  /** Grace for the tap↔utterance ordering race: an utterance ending this long
   *  before `now` (while a window is open) still counts (finish, then tap). */
  GRACE_MS: Number(process.env.CONV_GRACE_MS ?? 2_500),
  /** SPEAKING safety cap: if a tts-end is lost, SPEAKING can't wedge forever.
   *  Reconcile-on-connect is the primary recovery; this is the backstop. */
  SPEAK_MAX_MS: Number(process.env.CONV_SPEAK_MAX_MS ?? 30_000),
  /** A face arriving in view opens a brief low-priority listen window. */
  FACE_ARRIVAL_MS: Number(process.env.CONV_FACE_ARRIVAL_MS ?? 5_000),
  /** Whether a face arriving in view opens a listen window AT ALL. Default OFF:
   *  walking up to the dock should NOT start it listening — that competes/confuses
   *  with the deliberate triggers (tap, and now the open-palm WAVE gesture). Only
   *  tap/wave/followup open a window. Set CONV_FACE_ARRIVAL=1 to restore wake-on-
   *  look. (faceLeft stays harmless — it only ever closed a face window.)
   *  Read at CALL time (a getter) so it's togglable at runtime + in tests. */
  get FACE_ARRIVAL_ENABLED(): boolean { return process.env.CONV_FACE_ARRIVAL === '1'; },
  /** After a face-presence window ends, ignore a new face-arrival for this long.
   *  Stops the on-off-on-off flap when someone paces in and out of frame: once a
   *  presence window closes, the dock won't re-open one on camera presence until
   *  the cooldown passes. (The phone-side PresenceGate already requires near +
   *  centered + sustained; this is the station's backstop against rapid re-trigger.)
   *  A TAP is never subject to this — a deliberate tap always opens immediately. */
  FACE_COOLDOWN_MS: Number(process.env.CONV_FACE_COOLDOWN_MS ?? 12_000),
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
  #lastWindowUntil = 0; // expiry of the MOST RECENT window, kept after it closes — so a
                        // long utterance that STARTED while listening still counts as
                        // addressed even if it ENDS after the window expired (no cut-off).
  #windowOpenedAt = 0;  // when the most-recent window OPENED. With #lastWindowUntil this
                        // forms the [opened, closed] interval an utterance must have
                        // STARTED within to count — robust to prune/consume timing (the
                        // intermittent "UI says listening but no reply" race: the old
                        // rescue depended on #lastWindowUntil not being zeroed/clamped
                        // before the final landed, which a tick or a prior consume broke).
  #windowSrc: WindowSource = 'tap'; // why the current window is open (priority)
  #speakUntil = 0;  // SPEAKING safety expiry (ms), or 0
  #faceCooldownUntil = 0; // a face-arrival is ignored until this time (anti-flap)
  #muted = false;   // phone mic OFF ⇒ NOT listening: while true, NO window opens
                    // (tap/face/vad/utterance are inert) and any open one is closed.
                    // The phone reports mute via the 'mic-muted' agent frame.
  #onTransition?: (t: ConvTransition) => void;

  constructor(onTransition?: (t: ConvTransition) => void) {
    this.#onTransition = onTransition;
  }

  // ── reads (prune first so expiries are reflected) ─────────────────────────

  mode(now: number): ConvMode { this.#prune(now); return this.#mode; }
  // Mic OFF ⇒ NOT listening, regardless of mode. This is the authoritative gate for
  // BOTH the interim caption (index.ts setListeningResolver) and turn admission
  // (utteranceEnded below) — so even if a window re-opened while muted (e.g. a turn
  // that was in flight when the user muted completes → speakEnd; guarded there too,
  // this is the belt-and-suspenders), no interim flows and no utterance is addressed.
  isListening(now: number): boolean { if (this.#muted) return false; const m = this.mode(now); return m === 'listening' || m === 'followup'; }
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

  /** Tap is a TOGGLE / INTERRUPT:
   *   - listening/followup → close (tap-off, D1);
   *   - idle               → open an explicit LISTENING window;
   *   - thinking/speaking  → INTERRUPT the in-flight reply: drop the speak window
   *     and open a fresh listening window. The `*->listening` transition is the
   *     signal the session uses to abort the active turn (tap-to-interrupt). This
   *     is deliberate (a real tap), so it can't false-trigger like raw VAD would. */
  tap(now: number): void {
    this.#prune(now);
    // Mic OFF ⇒ NOT listening: a tap can't open a window while muted. (The phone
    // shouldn't send taps when muted, but the station is the owner — guard here too.)
    if (this.#muted) { if (this.#mode === 'listening' || this.#mode === 'followup') { this.#set('idle', now, 'tap-off'); this.#windowUntil = 0; this.#lastWindowUntil = now; } return; }
    if (this.#mode === 'listening' || this.#mode === 'followup') {
      // tap-off deliberately closes the window → clamp the long-utterance grace to now
      // (see #prune) so later overheard speech isn't treated as addressed.
      this.#set('idle', now, 'tap-off'); this.#windowUntil = 0; this.#lastWindowUntil = now;
    } else if (this.#mode === 'idle') {
      this.#openWindow('tap', now + ConvCfg.LISTEN_MS, now, 'tap');
    } else if (this.#mode === 'thinking' || this.#mode === 'speaking') {
      this.#speakUntil = 0;
      this.#openWindow('tap', now + ConvCfg.LISTEN_MS, now, 'tap-interrupt');
    }
  }

  /** ADDRESS, open-only (the palm gesture). Like {@link tap} but NEVER toggles a
   *  window OFF — a palm always means "listen to me", never "go away". This fixes
   *  the palm-interrupt bug: a palm shown while the dock is SPEAKING raced the
   *  natural speaking→followup transition; arriving in 'followup', plain tap() did
   *  tap-OFF → idle, and the user's next utterance was dropped as not-addressed.
   *  Open-only: from idle/listening/followup → (re)open a listening window; from
   *  thinking/speaking → interrupt into a window. It can only ever leave the dock
   *  LISTENING. */
  tapOpen(now: number): void {
    this.#prune(now);
    if (this.#muted) return; // mic OFF ⇒ no window opens (palm included)
    if (this.#mode === 'thinking' || this.#mode === 'speaking') {
      this.#speakUntil = 0;
      this.#openWindow('tap', now + ConvCfg.LISTEN_MS, now, 'palm-interrupt');
    } else {
      // idle / listening / followup → ensure a fresh listening window is open.
      this.#openWindow('tap', now + ConvCfg.LISTEN_MS, now, 'palm-address');
    }
  }

  /** True if `tap()` at `now` would INTERRUPT an in-flight reply (mode thinking or
   *  speaking) — the session checks this before tapping to know whether to abort
   *  the active turn. Pure (prunes, no mutation). */
  tapWouldInterrupt(now: number): boolean {
    this.#prune(now);
    return this.#mode === 'thinking' || this.#mode === 'speaking';
  }

  /** A NEW face arrived in view → a low-priority listen window (D3): yields to an
   *  active tap/followup (won't override a higher window), opens one when idle.
   *  Suppressed during the post-presence COOLDOWN so pacing in/out of frame can't
   *  flap the dock on-off-on-off (the phone-side PresenceGate already requires the
   *  face to be near + centered + sustained; this is the station's backstop). */
  faceArrival(now: number): void {
    if (!ConvCfg.FACE_ARRIVAL_ENABLED) return; // wake-on-look disabled (tap/wave only)
    if (this.#muted) return; // mic OFF ⇒ a face must not wake a listening window
    this.#prune(now);
    if (now < this.#faceCooldownUntil) return; // still cooling down from the last presence
    if (this.#mode === 'idle') this.#openWindow('face', now + ConvCfg.FACE_ARRIVAL_MS, now, 'face-arrival');
    // if already listening/followup/thinking/speaking → ignore (don't downgrade).
  }

  /** A face LEFT view → release ONLY a low-priority face window. It must NOT
   *  cancel a tap or follow-up (D2: a glance away doesn't end your conversation).
   *  Starts the anti-flap cooldown so an immediate re-arrival doesn't re-trigger. */
  faceLeft(now: number): void {
    this.#prune(now);
    if ((this.#mode === 'listening' || this.#mode === 'followup') && this.#windowSrc === 'face') {
      this.#windowUntil = 0;
      this.#lastWindowUntil = now; // clamp the long-utterance grace to the actual close
      this.#faceCooldownUntil = now + ConvCfg.FACE_COOLDOWN_MS;
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

  /** TTS finished → auto re-listen (FOLLOWUP, high priority — survives face-leave).
   *  No-op unless we're actually SPEAKING: a tts-end that arrives AFTER a tap-to-
   *  interrupt already moved us to a tap LISTENING window must not clobber it with a
   *  lower-priority followup window (the interrupt's deliberate tap wins). */
  speakEnd(now: number): void {
    this.#prune(now);
    if (this.#mode !== 'speaking') return; // already left speaking (e.g. tap-interrupt)
    this.#speakUntil = 0;
    // Mic OFF ⇒ NOT listening: a turn that was already speaking when the user muted
    // must NOT re-open a followup window on tts-end. Go straight to idle (the phone
    // gets the idle frame and drops the glow/caption). Without this, the dock would
    // silently re-listen while muted — and the never-muted WebRTC mic could fire a
    // live turn (utteranceEnded is also mute-gated, but fix the STATE, not just reads).
    if (this.#muted) { this.#windowUntil = 0; this.#set('idle', now, 'tts-end-muted'); return; }
    this.#windowSrc = 'followup';
    this.#setWindow(now + ConvCfg.FOLLOWUP_MS);
    this.#set('followup', now, 'tts-end');
  }

  /** VAD edge — make the listening window FOLLOW voice activity (endpoint-based, not a
   *  fixed timeout):
   *   - active=true  → HOLD the window open with no ceiling while you're talking (push
   *     expiry far out; re-pushed by the phone's keepalive). Talk as long as you like.
   *   - active=false → a real END of speech (the phone only sends this after ~1.5s
   *     sustained silence): release to a short ENDPOINT so the utterance commits soon.
   *  No-op if no window is open. Back-compat: a call with no arg = active (old phones). */
  vadActivity(now: number, active = true): void {
    this.#prune(now);
    if (this.#mode !== 'listening' && this.#mode !== 'followup') return;
    if (active) {
      // hold open — far enough out that only a vad-end (or the keepalive lapsing on a
      // disconnect) closes it.
      this.#setWindow(Math.max(this.#windowUntil, now + ConvCfg.VAD_HOLD_MS));
    } else {
      // speech ENDED → release to a short endpoint. BUT only shorten the window if it
      // was actually HELD open by speech (a long hold). A vad-end arriving on a fresh
      // tap window (before you've said anything — e.g. from the tap-beep) must NOT slam
      // it shut early; only ever shorten, never lengthen, and never below now+endpoint.
      const endpoint = now + ConvCfg.VAD_ENDPOINT_MS;
      const wasHeld = this.#windowUntil > now + ConvCfg.LISTEN_MS; // only a hold exceeds LISTEN_MS
      if (wasHeld) this.#setWindow(endpoint);
      // else: leave the normal tap/followup window alone — you haven't started talking.
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
  /** TEMP DIAGNOSTIC: expose #lastWindowUntil so the addressed-trace shows the real
   *  grace horizon that let an utterance through. */
  get lastWindowUntil(): number { return this.#lastWindowUntil; }

  utteranceEnded(endedAt: number, now: number, startedAt?: number): boolean {
    this.#prune(now);
    // Mic OFF ⇒ no utterance is addressed, full stop. The WebRTC mic isn't actually
    // muted (only the local pipeline is), so audio still reaches STT; this is the gate
    // that stops a "muted" dock from hearing + replying to a real spoken utterance.
    if (this.#muted) return false;
    const windowOpenNow = this.#mode === 'listening' || this.#mode === 'followup';
    // STARTED-WHILE-OPEN (the robust rescue): an utterance you BEGAN while the window
    // was open is addressed, even if the FINAL only lands after the window has since
    // closed (STT adds ~1.3s trailing silence; a conv-tick can prune the window to idle
    // in that gap). Qualify on the OPEN INTERVAL [openedAt, lastWindowUntil]:
    //   openedAt - GRACE  ≤  startedAt  ≤  lastWindowUntil
    // The leading GRACE absorbs the tap↔speech ordering race (you start a beat before
    // the tap registers); the far end is the window's REAL close (#prune pins
    // #lastWindowUntil to the true expiry, never `now`, so speech begun AFTER close is
    // still excluded). This does NOT depend on #lastWindowUntil surviving a prior
    // consume — the previous bug: a same-breath 2nd utterance, or a tick that pruned +
    // a stale zeroing, made the old `startedAt <= #lastWindowUntil` check fail
    // intermittently (the "UI says listening but no reply" race).
    const inOpenInterval = startedAt != null && this.#lastWindowUntil > 0
      && startedAt >= this.#windowOpenedAt - ConvCfg.GRACE_MS
      && startedAt <= this.#lastWindowUntil;
    if (!windowOpenNow && !inOpenInterval) return false;
    if (windowOpenNow && endedAt < now - ConvCfg.GRACE_MS) return false;
    this.#windowUntil = 0;
    // DON'T zero #lastWindowUntil/#windowOpenedAt here — keeping the just-closed
    // interval lets a follow-on utterance from the SAME breath still qualify; a NEW
    // window (tap/followup) overwrites the interval via #setWindow + #set anyway.
    this.#set('thinking', now, 'addressed-utterance');
    return true;
  }

  /** The phone (re)connected → reconcile to a clean slate (a fresh phone is idle,
   *  not speaking). Clears a stale SPEAKING a lost tts-end would otherwise wedge. */
  reconcileConnected(now: number): void {
    this.#speakUntil = 0; this.#windowUntil = 0;
    this.#set('idle', now, 'reconnect');
  }

  /** Phone mic muted/unmuted. Mic OFF ⇒ NOT listening: while muted, NO window opens
   *  (tap/face/vad/utterance are inert — guarded above) and any OPEN listening/followup
   *  window is closed immediately to idle. Unmuting just lifts the gate; it does not
   *  re-open a window (the user taps to talk again). Idempotent. */
  setMuted(muted: boolean, now: number): void {
    this.#muted = muted;
    if (muted && (this.#mode === 'listening' || this.#mode === 'followup')) {
      this.#windowUntil = 0; this.#lastWindowUntil = now;
      this.#set('idle', now, 'mic-muted');
    }
  }
  isMuted(): boolean { return this.#muted; }

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
      // A face-presence window that times out also starts the anti-flap cooldown,
      // so a face still lingering in frame doesn't immediately re-open it.
      if (this.#windowSrc === 'face') this.#faceCooldownUntil = now + ConvCfg.FACE_COOLDOWN_MS;
      // CLAMP the long-utterance grace to the window's ACTUAL EXPIRY (#windowUntil),
      // NOT `now`. #prune runs lazily — usually inside utteranceEnded() at the new
      // utterance's `now`, which can be many seconds after the window really expired.
      // Clamping to `now` therefore left the grace covering speech spoken long after
      // the window closed (the bug: trace showed mode=idle msToExpiry=0, yet a fresh
      // "Can you hear this?" — startedAt ~2s before now — still passed startedWhileOpen
      // because we'd just set #lastWindowUntil=now). Pin to the real expiry instead, so
      // only an utterance that was ending AS the window closed keeps the GRACE tail.
      this.#lastWindowUntil = this.#windowUntil;
      this.#windowUntil = 0;
      this.#set('idle', now, 'window-timeout');
    }
  }

  /** Open a listening window of a given source (priority) → listening. */
  #openWindow(src: WindowSource, until: number, now: number, reason: string): void {
    this.#windowSrc = src;
    this.#setWindow(until);
    this.#set('listening', now, reason);
  }

  /** Set the window expiry, also recording it as the most-recent window expiry
   *  (#lastWindowUntil) so a long utterance that started while open still counts. */
  #setWindow(until: number): void {
    this.#windowUntil = until;
    this.#lastWindowUntil = Math.max(this.#lastWindowUntil, until);
  }

  #set(to: ConvMode, at: number, reason: string): void {
    if (to === this.#mode) return;
    const from = this.#mode;
    // Mark a FRESH window-open interval when ENTERING listening/followup from a
    // non-window mode. Re-opening while already in a window keeps the original
    // openedAt (just extends the far end via #setWindow) — so an utterance begun
    // anywhere in a continuous listening session still counts as addressed.
    const enteringWindow = (to === 'listening' || to === 'followup');
    const wasInWindow = (from === 'listening' || from === 'followup');
    if (enteringWindow && !wasInWindow) this.#windowOpenedAt = at;
    this.#mode = to;
    this.#onTransition?.({ from, to, reason, at });
  }
}
// keep SRC_PRIORITY referenced (priority is encoded in faceLeft's source check;
// exported map is available for future multi-source arbitration if needed).
void SRC_PRIORITY;
