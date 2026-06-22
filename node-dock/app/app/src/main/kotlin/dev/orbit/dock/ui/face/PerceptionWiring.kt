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
    // ── conversation: the STATION owns the state machine; the phone REPORTS raw
    // events up and RENDERS the mode it sends back. These are the report-up hooks
    // (wired to RemoteBrain.sendVad/sendFaceArrival/sendFaceLeft in DockScreen).
    private val sendVad: (active: Boolean) -> Unit = {},
    private val sendFaceArrival: () -> Unit = {},
    private val sendFaceLeft: () -> Unit = {},
    /** The station's conversation mode flow (idle/listening/thinking/speaking/
     *  followup) — the phone renders this; it does NOT decide listening locally. */
    private val convMode: StateFlow<String>? = null,
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

    // Gates raw face detections into clean ARRIVE/LEAVE edges (near + centered +
    // sustained) so presence-listening doesn't flap as people move through frame.
    private val presenceGate = PresenceGate()
    // last rendered "listening" edge, so the face/beep fire only on transitions.
    @Volatile private var listeningRendered = false

    /** RENDER the station's conversation mode onto the face + cues. The station is
     *  the sole owner of listening/speaking/idle — the phone just reflects it.
     *
     *  CUE POLICY: the on/off pip + haptic mark only the meaningful "(not) attending
     *  to you" transitions, and NEVER fire around speech. So:
     *   - `followup` (the auto-relisten right AFTER a reply) does NOT cue — the dock
     *     just spoke; a beep there is redundant and lands on the TTS audio path.
     *   - the OFF cue is suppressed when the window closes INTO a turn (the dock is
     *     about to speak — `thinking`/`speaking`); a beep right before TTS is the
     *     collision the user reported. It only cues when listening genuinely ends to
     *     `idle` (you stopped / timed out without a reply).
     *  Net: ON cue when idle→listening (you addressed it, now attending); OFF cue
     *  when listening→idle. The face still updates for every state (glow/listen). */
    private fun renderConvMode(mode: String) {
        // "Attending" for the FACE glow/state includes followup; for CUES we use the
        // narrower "listening" only (followup is post-speech, no cue).
        val attending = mode == "listening" || mode == "followup"
        val cueOn = mode == "listening"
        if (cueOn != listeningRendered) {
            listeningRendered = cueOn
            if (cueOn) {
                HapticCue.listeningOn()
                BeepPlayer.listeningOn() // light high pip (+ haptic + the face glow)
            } else if (mode == "idle") {
                // Only cue OFF on a real end-to-idle — NOT when closing into a turn
                // (thinking/speaking), where a beep would step on the reply's TTS.
                HapticCue.listeningOff()
                BeepPlayer.listeningOff()
            }
        }
        // Face state follows the STATION's attending mode (covers followup too). The
        // glow MUST track the station's listening window — it's the authoritative owner.
        // BUG FIXED: the old guard only called listen() from FaceState.Idle, so when the
        // station opened a window while the face was in any other state (Engaged, or a
        // followup right after Speaking), the glow never turned on even though the
        // countdown showed listening — the intermittent "listening, countdown, but no
        // glow, and it didn't hear me". Now: enter Listening whenever attending and not
        // already Listening; leave it when no longer attending. Don't stomp Speaking
        // (the dock is replying) — but attending is false during thinking/speaking, so
        // this only ever flips between Listening and Idle/Engaged.
        if (attending) {
          if (controller.state.value != FaceState.Listening
              && controller.state.value != FaceState.Speaking) controller.listen()
        } else {
          if (controller.state.value == FaceState.Listening) controller.silence()
        }
    }

    fun attach(scope: CoroutineScope) {
        // Render the station's conversation mode (the phone is a pure renderer).
        convMode?.let { flow ->
            flow.onEach { renderConvMode(it) }.launchIn(scope)
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
                        // Report BOTH VAD edges up: active=true HOLDS the listening window
                        // open (no ceiling while you talk), active=false (a real ~1.5s
                        // silence end) RELEASES it to a short endpoint. The station's window
                        // follows VAD instead of a fixed timeout — talk as long as you like.
                        sendVad(event.active)
                    }
                    is PerceptionEvent.SttListening -> {
                        // legacy local-STT signal; the station owns listening now.
                        _sttArmed.value = event.armed
                    }
                    is PerceptionEvent.StopListening -> {
                        // Explicit user stop = a tap (the station toggles listening off).
                        _sttArmed.value = false
                        onWake() // → agent.addressed() (tap toggle)
                    }
                    is PerceptionEvent.Speaking -> {
                        // The station drives speaking/followup from the TTS speech-
                        // status frames (RemoteBrain.setSpeaking) → it emits the
                        // conversation mode we render. Nothing to decide here.
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
                        // Tap (or a debug/dev wake) = the user TOGGLING addressed
                        // listening. Report it up (onWake → agent.addressed()); the
                        // STATION toggles + emits the conversation mode we render.
                        // (Face-arrival no longer routes through here — FaceSeen
                        // reports face-arrival up directly.)
                        Timber.i("tap → station: ${event.label}")
                        _transcript.value = TranscriptState()
                        onWake()
                    }
                    is PerceptionEvent.Transcript -> {
                        // Transcripts arrive FROM the station's always-on STT. Just
                        // render the words; the station owns turn-building + the face
                        // mode (no local listening decisions here).
                        Timber.d("transcript (station): \"${event.text}\" final=${event.isFinal}")
                        _transcript.value = TranscriptState(event.text, event.isFinal)
                        if (event.isFinal && event.text.isNotBlank() && shouldWinkFor(event.text)) {
                            controller.wink()
                        }
                    }
                    is PerceptionEvent.FaceSeen -> {
                        _facePresent.value = true
                        // PRESENCE GATE: only report an arrival when a face is NEAR +
                        // CENTERED + SUSTAINED — a person settling in front of the dock,
                        // not someone walking past / lingering far / flickering at the
                        // edge. The raw FaceSeen still drives gaze + the snapshot below
                        // every frame; only the station-facing arrival/leave edge is
                        // gated (kills the on-off-on-off presence flap).
                        when (presenceGate.onFace(event.x, event.y, event.size, System.currentTimeMillis())) {
                            PresenceGate.Edge.ARRIVE -> sendFaceArrival()
                            PresenceGate.Edge.LEAVE -> sendFaceLeft()
                            PresenceGate.Edge.NONE -> {}
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
                        // Feed the gate a "no face" tick — it debounces into a LEAVE
                        // only after the grace window (a brief look-away doesn't end
                        // presence). The station releases ONLY a face window (D2).
                        if (presenceGate.onNoFace(System.currentTimeMillis()) == PresenceGate.Edge.LEAVE) {
                            sendFaceLeft()
                        }
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
                    is PerceptionEvent.HandGesture -> {
                        // On-device hand gesture (MediaPipe; PalmDetector). Consumed
                        // ELSEWHERE: the CameraPreview overlay reads it for live
                        // status, and DockScreen routes a palm (event.palm) to
                        // address/barge-in/stop (mirror of a tap). Nothing to do
                        // here — kept as a branch so the `when` stays exhaustive and
                        // a single owner (DockScreen) acts on the palm (no double-fire).
                    }
                    is PerceptionEvent.Status -> {
                        // Pipeline status text only. The station owns the face mode
                        // now (rendered from convMode), so no local silence here.
                        _pipelineStatus.value = event.message
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
