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
    private val sendVad: () -> Unit = {},
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

    // for the face arrival/leave edge (report-up only — the station decides).
    @Volatile private var faceCurrentlyPresent = false
    // last rendered "listening" edge, so the face/beep fire only on transitions.
    @Volatile private var listeningRendered = false

    /** RENDER the station's conversation mode onto the face + beeps. The station is
     *  the sole owner of listening/speaking/idle — the phone just reflects it. The
     *  on↔off "listening" edge drives the beep; we don't fight the agent turn while
     *  it's Speaking/Engaged (that's driven by the TTS callback). */
    private fun renderConvMode(mode: String) {
        val on = mode == "listening" || mode == "followup"
        if (on != listeningRendered) {
            listeningRendered = on
            if (on) {
                BeepPlayer.listeningOn()
                if (controller.state.value == FaceState.Idle) controller.listen()
            } else {
                BeepPlayer.listeningOff()
                if (controller.state.value == FaceState.Listening) controller.silence()
            }
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
                        // Report VAD up — the station extends an open listening/
                        // followup window so a slow speaker isn't cut off.
                        if (event.active) sendVad()
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
                        // Report the NEW-face arrival edge UP — the station decides
                        // whether to open a (low-priority) listen window. The phone
                        // no longer auto-listens locally.
                        if (!faceCurrentlyPresent) {
                            faceCurrentlyPresent = true
                            sendFaceArrival()
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
                        // Report the face-left UP — the station releases ONLY a face
                        // listen window (never a tap/follow-up; D2 enforced there).
                        sendFaceLeft()
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
