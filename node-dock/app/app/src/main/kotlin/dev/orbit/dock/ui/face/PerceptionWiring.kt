package dev.orbit.dock.ui.face

import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import timber.log.Timber

/** Live transcript snapshot for the subtitle band. */
data class TranscriptState(
    val text: String = "",
    val isFinal: Boolean = true,
) {
    val isEmpty: Boolean get() = text.isBlank()
}

/**
 * Bridges PerceptionBus events into the FaceController and exposes the
 * live audio level + transcript for the UI to render.
 *
 * Owned by the UI scope so it goes away with the screen.
 */
class PerceptionWiring(
    private val controller: FaceController,
    private val onUserUtterance: (String) -> Unit = {},
    private val onWake: () -> Unit = {},
    /** Live-senses snapshot the agent reads per turn. Updated here from the
     *  same FaceSeen/FaceLost/UserEmotion events that drive gaze + mirroring,
     *  so the LLM's "what do you see?" is grounded. */
    private val perception: dev.orbit.dock.agent.PerceptionSnapshot? = null,
) {
    private val _audioLevel = MutableStateFlow(0f)
    val audioLevel: StateFlow<Float> = _audioLevel.asStateFlow()

    private val _pipelineStatus = MutableStateFlow("starting…")
    val pipelineStatus: StateFlow<String> = _pipelineStatus.asStateFlow()

    private val _transcript = MutableStateFlow(TranscriptState())
    val transcript: StateFlow<TranscriptState> = _transcript.asStateFlow()

    /** Clear the on-screen transcript. Called when the agent finishes a turn so
     *  the user's words don't linger forever on an action-only (no-speech)
     *  turn — by then the spoken reply / status has had its say. */
    fun clearTranscript() { _transcript.value = TranscriptState() }

    private val _facePresent = MutableStateFlow(false)
    val facePresent: StateFlow<Boolean> = _facePresent.asStateFlow()

    // Real moment-to-moment STT armed state, tracked across re-arm cycles.
    // The face state stays "Listening" through a whole session (no flicker),
    // but the UI hint binds to THIS so the on-screen text honestly says
    // "I'm listening" when the mic is actually armed and "one sec…" during the
    // brief re-arm gap between one-shot recognizer attempts.
    private val _sttArmed = MutableStateFlow(false)
    val sttArmed: StateFlow<Boolean> = _sttArmed.asStateFlow()

    // Auto-listen-on-face: arm a listening session once when a NEW face appears
    // (absent → present edge), unless the dock is speaking or already listening.
    @Volatile private var faceCurrentlyPresent = false   // for the arrival edge
    @Volatile private var dockSpeaking = false           // TTS playing
    // The SINGLE owner of listening mode — prioritized holds (tap / follow-up /
    // face-arrival) so a low-priority OFF can't cancel a high-priority ON.
    private val arbiter = ListeningArbiter()
    // last applied listening edge, so we drive face/beeps only on transitions.
    @Volatile private var listeningActive = false
    // a periodic tick prunes expired holds → produces the OFF edge.
    private var arbiterTick: kotlinx.coroutines.Job? = null
    // Cool-off: after an auto-listen fires, suppress the next for this long so a
    // face flickering at the edge of detection doesn't keep re-arming listening.
    @Volatile private var lastAutoListenMs = 0L
    private val autoListenCooldownMs = 8_000L

    @Volatile private var lastFaceMs = 0L
    @Volatile private var lastVoiceMs = 0L
    @Volatile private var lastGazeVoiceWakeMs = 0L
    @Volatile private var audioAboveCount = 0
    // Tunables — these are conservative defaults so the trigger doesn't
    // misfire on background TV chatter / passing footsteps. Tighten with
    // user feedback once we've lived with it for a bit.
    private val audioWakeThreshold = 0.05f       // RMS [0..1]
    private val audioWakeRequiredFrames = 2      // consecutive frames above threshold
    private val faceFreshnessMs = 3500L          // face must have been seen within
    private val wakeCooldownMs = 2000L           // suppress repeated triggers
    private val LISTEN_ACK_TIMEOUT_MS = 8_000L   // tap-but-no-speech → drop Listening

    /** Reconcile the visible face + beeps to the arbiter's current state. Drives
     *  the listen()/silence() + on/off beep ONLY on the on↔off edge. The agent
     *  turn owns the face while Speaking/Engaged, so we don't fight it. */
    private fun applyListening() {
        val now = System.currentTimeMillis()
        val on = arbiter.isListening(now)
        if (on == listeningActive) return // no edge
        listeningActive = on
        if (on) {
            Timber.i("listening ON (${arbiter.active(now)})")
            BeepPlayer.listeningOn()
            if (controller.state.value == FaceState.Idle) controller.listen()
        } else {
            Timber.i("listening OFF")
            BeepPlayer.listeningOff()
            if (controller.state.value == FaceState.Listening) controller.silence()
        }
    }

    fun attach(scope: CoroutineScope) {
        // Tick the arbiter so expiring holds produce the OFF edge even with no event.
        arbiterTick = scope.launch {
            while (true) { kotlinx.coroutines.delay(500); applyListening() }
        }
        PerceptionBus.events
            .onEach { event ->
                when (event) {
                    is PerceptionEvent.AudioLevel -> {
                        // Just drive the level meter. No wake-on-look anymore —
                        // listening is tap-only (see WakeWord/StopListening).
                        _audioLevel.value = event.level
                    }
                    is PerceptionEvent.VoiceActivity -> {
                        controller.userVoice(event.active)
                        // During the follow-up window, the user starting to talk
                        // extends it so a slow follow-up isn't cut off mid-sentence.
                        if (event.active) {
                            arbiter.extendFollowup(System.currentTimeMillis())
                            applyListening()
                        }
                    }
                    is PerceptionEvent.SttListening -> {
                        // The mic's real moment-to-moment armed state. Track it
                        // so the UI hint can honestly say "I'm listening" vs.
                        // "one sec…" each re-arm cycle. The FACE state stays
                        // Listening across the whole session (only the session-
                        // end Status drops it to Idle) — that's what avoids the
                        // jarring face flicker — but the text reflects reality.
                        _sttArmed.value = event.armed
                        if (event.armed) {
                            controller.listen()
                        }
                    }
                    is PerceptionEvent.StopListening -> {
                        // Explicit user stop — clears the user hold (top priority).
                        _sttArmed.value = false
                        arbiter.clear(ListeningArbiter.Source.USER)
                        arbiter.clear(ListeningArbiter.Source.FOLLOWUP)
                        applyListening()
                    }
                    is PerceptionEvent.Speaking -> {
                        dockSpeaking = event.active
                        // The dock JUST FINISHED replying → auto re-listen for a
                        // hands-free follow-up (FOLLOWUP priority — a face-leave
                        // can't cancel it; VAD activity extends it). On speak START,
                        // nothing (we don't listen to our own voice — server AEC +
                        // the turn owns the face).
                        if (!event.active) {
                            arbiter.hold(ListeningArbiter.Source.FOLLOWUP,
                                System.currentTimeMillis(), ListeningArbiter.Cfg.FOLLOWUP_MS)
                            applyListening()
                        }
                    }
                    is PerceptionEvent.BargeIn -> {
                        // Voice barge-in is handled in DockScreen (stops TTS +
                        // the turn, then re-arms). Nothing to do here; branch
                        // keeps the when exhaustive.
                    }
                    is PerceptionEvent.RunAecTest -> {
                        // Debug AEC self-test is handled in DockScreen (it owns
                        // the Speaker). Nothing to do here; keeps when exhaustive.
                    }
                    is PerceptionEvent.WakeWord -> {
                        // Tap / wake / face-arrival = a listening request. Route it
                        // through the arbiter at the right priority; the face + beeps
                        // come from applyListening on the edge. The USER hold expires
                        // after USER_ACK_MS (the tap-but-no-speech guard); the
                        // sentence-end (final transcript) clears it sooner.
                        Timber.i("listen request: ${event.label}")
                        val now = System.currentTimeMillis()
                        if (event.label == "(face)") {
                            arbiter.hold(ListeningArbiter.Source.FACE_ARRIVAL, now,
                                ListeningArbiter.Cfg.FACE_ARRIVAL_MS)
                        } else {
                            arbiter.hold(ListeningArbiter.Source.USER, now,
                                ListeningArbiter.Cfg.USER_ACK_MS)
                        }
                        _transcript.value = TranscriptState()
                        applyListening()
                        onWake()
                    }
                    is PerceptionEvent.Transcript -> {
                        // A1.2: transcripts now arrive FROM the station's always-on
                        // STT (not a local recognizer). They're utterance-final, and
                        // the server VAD endpoint IS the sentence-end signal — so a
                        // final transcript ends the listening face. The station owns
                        // turn-building (the addressed latch), so we do NOT start a
                        // local turn here — we just show the words + resolve the face.
                        Timber.d("transcript (station): \"${event.text}\" final=${event.isFinal}")
                        _transcript.value = TranscriptState(event.text, event.isFinal)
                        if (event.isFinal) {
                            // sentence-end (server VAD endpoint): clear the USER tap
                            // hold. A FOLLOWUP hold (if the dock is mid-conversation)
                            // survives so the next sentence is still addressed; the
                            // agent turn drives Speaking. applyListening reconciles.
                            arbiter.clear(ListeningArbiter.Source.USER)
                            applyListening()
                            if (event.text.isNotBlank() && shouldWinkFor(event.text)) {
                                Timber.i("wink keyword trigger: \"${event.text}\"")
                                controller.wink()
                            }
                        }
                    }
                    is PerceptionEvent.FaceSeen -> {
                        lastFaceMs = System.currentTimeMillis()
                        _facePresent.value = true
                        // Auto-listen-on-face: on the absent→present edge (a NEW
                        // face arrival), start a listening session once — unless
                        // the dock is speaking or already listening. Re-arms only
                        // after the face leaves (FaceLost) and returns.
                        if (!faceCurrentlyPresent) {
                            faceCurrentlyPresent = true
                            val now = System.currentTimeMillis()
                            val cooledDown = now - lastAutoListenMs >= autoListenCooldownMs
                            // Only the LOW-priority face-arrival listen; it yields to
                            // a tap/follow-up already in progress (the arbiter enforces
                            // priority, but skipping here avoids a redundant beep).
                            if (!dockSpeaking && !listeningActive && cooledDown) {
                                lastAutoListenMs = now
                                Timber.i("auto-listen: new face appeared → start listening")
                                PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(face)"))
                            }
                        }
                        perception?.onFaceSeen(event.x, event.y)
                        // Map face position to eye gaze. Damp the magnitude so
                        // the eyes track but don't go full-corner.
                        controller.setGaze(GazeOffset(
                            x = (event.x * 0.7f).coerceIn(-1f, 1f),
                            y = (event.y * 0.5f).coerceIn(-1f, 1f),
                        ))
                    }
                    is PerceptionEvent.FaceLost -> {
                        _facePresent.value = false
                        faceCurrentlyPresent = false  // re-arm for the next arrival
                        // Leaving the camera releases ONLY the low-priority face hold
                        // — it must NOT cancel a tap or the just-replied follow-up
                        // window (your explicit conversational intent outranks a
                        // glance away). The arbiter enforces this.
                        arbiter.release(ListeningArbiter.Source.FACE_ARRIVAL.priority,
                            System.currentTimeMillis())
                        applyListening()
                        perception?.onFaceLost()
                        controller.setGaze(GazeOffset())
                    }
                    is PerceptionEvent.UserEmotion -> {
                        // Mirror the user's emotion to the dock's face while
                        // we're idle/listening (passive). Speaking is skipped
                        // inside setExpressionPassive() so the bot's intentional
                        // expression isn't clobbered mid-reply.
                        val mirrored = when (event.kind) {
                            PerceptionEvent.UserEmotion.Kind.Happy -> FaceExpression.Happy
                            PerceptionEvent.UserEmotion.Kind.Sleepy -> FaceExpression.Sleepy
                            PerceptionEvent.UserEmotion.Kind.Sad -> FaceExpression.Sad
                            PerceptionEvent.UserEmotion.Kind.Angry -> FaceExpression.Angry
                            PerceptionEvent.UserEmotion.Kind.Surprised -> FaceExpression.Surprised
                            PerceptionEvent.UserEmotion.Kind.Neutral -> FaceExpression.Neutral
                        }
                        Timber.d("user emotion: ${event.kind} conf=${"%.2f".format(event.confidence)} → ${mirrored.name}")
                        perception?.onEmotion(event.kind.name)
                        controller.setExpressionPassive(mirrored)
                    }
                    is PerceptionEvent.UserIdentified -> {
                        // Station recognized (or un-recognized) the user → fold the
                        // name into the snapshot so the next turn's prompt names them.
                        // Identity results only carry a name on a CONFIDENT match,
                        // so cache it verified (passing nothing here used to zero
                        // the confidence and make the prompt perpetually unsure).
                        Timber.i("station identity: ${event.name ?: "unrecognized"} conf=${"%.2f".format(event.confidence)}")
                        perception?.onIdentity(event.name, verified = true)
                    }
                    is PerceptionEvent.RemotePresence -> {
                        // Station-side coarse presence — informational only. It does
                        // NOT touch identity (one writer: UserIdentified), so it can't
                        // race the name. Kept for any future presence-only UI.
                        Timber.d("station presence: ${event.present}")
                    }
                    is PerceptionEvent.Status -> {
                        _pipelineStatus.value = event.message
                        Timber.d("perception status: ${event.source} - ${event.message}")
                        // Only "session_ended" returns the face to Idle. A
                        // per-shot "final" (SpeechRecognizer ended one attempt)
                        // is NOT session end — the pipeline re-arms for
                        // continuous listening, so silencing here would make
                        // the face flicker Idle↔Listening every ~5s. The
                        // pipeline emits "session_ended" exactly once when the
                        // whole listening session is truly over (timeout /
                        // tap-stop / transcript handed off).
                        if (event.message == "session_ended") {
                            _sttArmed.value = false
                            listeningActive = false
                            val s = controller.state.value
                            if (s == FaceState.Listening || s == FaceState.Engaged) {
                                Timber.i("listening session ended → face back to Idle")
                                controller.silence()
                            }
                        }
                    }
                    is PerceptionEvent.Error -> {
                        // Per-shot STT errors (no_match etc.) are normal during
                        // continuous listening and must NOT change face state —
                        // the pipeline decides whether to re-arm or end. Just
                        // surface the status text.
                        Timber.d("stt shot error: ${event.cause.message ?: ""}")
                    }
                }
            }
            .launchIn(scope)
    }
}

/**
 * Cheap keyword check: fires the brief wink gesture when the user says
 * something joke-y. Word-boundary regex so "winkle" / "joker" don't match.
 */
private val WINK_KEYWORD_REGEX = Regex(
    "\\b(joke|kidding|just kidding|jk|haha|hehe|lol|wink|cheeky|gotcha)\\b",
    RegexOption.IGNORE_CASE,
)

private fun shouldWinkFor(text: String): Boolean =
    WINK_KEYWORD_REGEX.containsMatchIn(text)
