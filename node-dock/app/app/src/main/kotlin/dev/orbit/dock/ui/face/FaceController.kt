package dev.orbit.dock.ui.face

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Owns the dock's face/state machine.
 *
 * Single source of truth for `FaceState`, `Speaker`, gaze, and expression.
 * Perception (mic, camera, touch) and the agent both push events here.
 * The composable renderers observe and animate.
 *
 * v1 keeps this minimal — later milestones will add timed transitions,
 * gesture queues, and body/face sync.
 */
class FaceController {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // Sleepy auto-trigger: if Idle this long, switch expression to Sleepy.
    private val sleepyAfterMs = 90_000L
    private var sleepyJob: Job? = null
    private var winkJob: Job? = null

    // After an explicit setExpression (LLM tool call, wink trigger, wake
    // reset), block passive (camera-driven) expression updates for this
    // window so the explicit choice has time to land. ~2.5s feels natural.
    private var passiveLockUntilMs: Long = 0
    private val passiveLockMs = 2500L
    private val STALE_GUARD_MS = 1200L

    private val _state = MutableStateFlow(FaceState.Idle)
    val state: StateFlow<FaceState> = _state.asStateFlow()

    private val _speaker = MutableStateFlow(Speaker.Silent)
    val speaker: StateFlow<Speaker> = _speaker.asStateFlow()

    private val _gaze = MutableStateFlow(GazeOffset())
    val gaze: StateFlow<GazeOffset> = _gaze.asStateFlow()

    private val _expression = MutableStateFlow(FaceExpression.Neutral)
    val expression: StateFlow<FaceExpression> = _expression.asStateFlow()

    // Independent mute flags. `privacy` (below) is true iff BOTH are muted —
    // the "panic / step away" composite. Callers that want fine-grained
    // control toggle the individual flags; callers that want classic
    // privacy mode use [togglePrivacy].
    private val _micMuted = MutableStateFlow(false)
    val micMuted: StateFlow<Boolean> = _micMuted.asStateFlow()

    private val _camMuted = MutableStateFlow(false)
    val camMuted: StateFlow<Boolean> = _camMuted.asStateFlow()

    private val _privacy = MutableStateFlow(false)
    val privacy: StateFlow<Boolean> = _privacy.asStateFlow()

    // ── intents ──────────────────────────────────────────────────────

    fun wake() {
        wakeUp()
        // Clear stale emotion from the previous turn — listening should
        // start from a clean, attentive face, not whatever mood the LLM
        // last set.
        if (_expression.value != FaceExpression.Neutral &&
            _expression.value != FaceExpression.Wink
        ) {
            _expression.value = FaceExpression.Neutral
        }
        passiveLockUntilMs = System.currentTimeMillis() + STALE_GUARD_MS
        if (_state.value == FaceState.Idle) _state.value = FaceState.Engaged
    }

    fun listen() {
        wakeUp()
        _state.value = FaceState.Listening
    }

    fun speak() {
        wakeUp()
        _state.value = FaceState.Speaking
        _speaker.value = Speaker.Bot
    }

    fun silence() {
        _state.value = FaceState.Idle
        _speaker.value = Speaker.Silent
        scheduleSleepy()
    }

    fun illustrate() {
        wakeUp()
        _state.value = FaceState.Illustrating
    }

    fun userVoice(active: Boolean) {
        if (active) wakeUp()
        _speaker.value = if (active) Speaker.User else Speaker.Silent
    }

    fun setGaze(offset: GazeOffset) { _gaze.value = offset }

    fun setExpression(e: FaceExpression) {
        // Cancel any in-flight wink restoration so the new explicit value sticks.
        winkJob?.cancel()
        winkJob = null
        _expression.value = e
        // Explicit setExpression locks out passive (camera-mirror) updates
        // so the explicit choice doesn't get clobbered immediately.
        passiveLockUntilMs = System.currentTimeMillis() + passiveLockMs
    }

    /**
     * Update expression from a *passive* source (camera-driven emotion
     * mirroring). Ignored if a recent explicit [setExpression] is still
     * within its lock-out window — so the LLM's tool calls always win.
     * Also ignored during Speaking (the bot's expression should reflect
     * its own reply, not your face).
     */
    fun setExpressionPassive(e: FaceExpression) {
        val now = System.currentTimeMillis()
        if (now < passiveLockUntilMs) return
        if (_state.value == FaceState.Speaking) return
        if (_expression.value == FaceExpression.Wink) return
        if (_expression.value == e) return
        _expression.value = e
    }

    /**
     * Brief wink gesture. Sets expression to [FaceExpression.Wink] for
     * [holdMs], then restores whatever expression was active before.
     * Repeated calls reset the timer.
     */
    fun wink(holdMs: Long = 700L) {
        val prev = _expression.value.takeUnless { it == FaceExpression.Wink }
            ?: FaceExpression.Neutral
        winkJob?.cancel()
        _expression.value = FaceExpression.Wink
        winkJob = scope.launch {
            delay(holdMs)
            _expression.value = prev
        }
    }

    fun togglePrivacy() {
        // Privacy = both off (or both back on if currently muted)
        val now = !_privacy.value
        setMicMuted(now)
        setCamMuted(now)
    }

    /** Toggle the mic mute. Updates `privacy` to reflect the composite. */
    fun toggleMic() = setMicMuted(!_micMuted.value)

    /** Toggle the camera mute. Updates `privacy` to reflect the composite. */
    fun toggleCam() = setCamMuted(!_camMuted.value)

    private fun setMicMuted(muted: Boolean) {
        _micMuted.value = muted
        syncPrivacyAndSpeaker()
    }

    private fun setCamMuted(muted: Boolean) {
        _camMuted.value = muted
        syncPrivacyAndSpeaker()
    }

    private fun syncPrivacyAndSpeaker() {
        val bothOff = _micMuted.value && _camMuted.value
        val anyOff = _micMuted.value || _camMuted.value
        _privacy.value = bothOff
        if (anyOff) {
            _state.value = FaceState.Idle
            sleepyJob?.cancel()
            sleepyJob = null
            _speaker.value = if (bothOff) Speaker.Muted else Speaker.Silent
        } else {
            _speaker.value = Speaker.Silent
            scheduleSleepy()
        }
    }

    /** Cancel any pending sleepy transition and bring face back to Neutral if currently Sleepy. */
    private fun wakeUp() {
        sleepyJob?.cancel()
        sleepyJob = null
        if (_expression.value == FaceExpression.Sleepy) {
            _expression.value = FaceExpression.Neutral
        }
    }

    private fun scheduleSleepy() {
        sleepyJob?.cancel()
        sleepyJob = scope.launch {
            delay(sleepyAfterMs)
            if (_state.value == FaceState.Idle &&
                _expression.value != FaceExpression.Sleepy
            ) {
                _expression.value = FaceExpression.Sleepy
            }
        }
    }
}
