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
class FaceController(
    /** Dispatcher for the timed transitions (sleepy/wink/decay). Main in the app;
     *  tests inject Unconfined so nothing touches the Android main looper
     *  (a turn unwinding after Dispatchers.resetMain() used to throw an
     *  uncaught "Main dispatcher missing" into the NEXT test). */
    dispatcher: kotlin.coroutines.CoroutineContext = Dispatchers.Main,
    /** Clock, injectable. The decay job mixes delay() — which tests drive
     *  with VIRTUAL time — with timestamp comparisons; on the wall clock a test
     *  could advance the scheduler 90s while zero real time passes, and the
     *  decay would be untestable (its assertions vacuous). */
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    // Sleepy auto-trigger: if Idle this long, switch expression to Sleepy.
    private val sleepyAfterMs = 90_000L
    private var sleepyJob: Job? = null
    private var winkJob: Job? = null

    /** When the dock last SETTLED (silence()) — the decay anchor. A mood's age
     *  is measured from here, not from when its tag was parsed: the tag lands
     *  seconds before the audio starts and the audio can run 95s
     *  (turn-75cb44ad), so parse-anchored decay would reset the face
     *  mid-sentence. */
    @Volatile private var lastSettledAtMs = 0L

    /**
     * How long a deliberate mood outlives the moment that caused it.
     *
     * A mood should outlive its SENTENCE, not its CONVERSATION. Measured live:
     * `curious` (the brain's #2 mood) sat on the face for 88 SECONDS, still 1.5s
     * short of the only thing that could ever clear it — the 90s sleepy timer.
     * That is the "face hangs" bug's real root: the earlier fix stopped the timer
     * being CANCELLED, but left it as the sole escape, and 90s is an eternity.
     *
     * 15s of QUIET: the decay anchors to max(set-time, last settle), so this
     * window only starts counting once the dock stops talking — a 95s story
     * keeps its face to the last word (the "wrong clock" objection, resolved).
     */
    private val moodTtlMs = 15_000L

    /** Sources whose moods DECAY. `react` is included: the EmotionGate only
     *  re-reacts on a CHANGE of camera read, so a reaction to someone who then
     *  walks away would pin forever — the same hang class as the LLM moods.
     *  (Trade-off, accepted: someone who keeps smiling sees the face settle to
     *  neutral after the afterglow; honest — the moment passed.)
     *  `boot`/`timer`/`wake`/`voice`/`decay` are already resting states. */
    private val decayingSources = setOf("llm", "debug", "react")

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

    /**
     * WHY the face looks the way it does — the dock's own account of its mood.
     *
     * The dock already knew WHAT it was showing (DockTools ships "Current face:"
     * every turn) but never WHY, so asked "why do you look sad?" it CONFABULATED
     * — inventing "my internal feelings sometimes show up automatically" when the
     * truth was that a camera copied the user's face onto it. A fact about
     * yourself with no provenance is an invitation to make one up.
     *
     * The reason does NOT need to be meaningful, only TRUE. "someone pressed a
     * button on the dev panel" is a great reason: honest, coherent, and it lets
     * the dock say "no idea, someone set it from the panel" — which is exactly
     * right and impossible today. Dumb-but-true beats profound-but-invented.
     *
     * [source] is for FILTERING (never feed a mirrored mood back to the LLM as
     * its own intent); [why] is for SPEAKING. Kept as a separate flow rather than
     * folded into _expression so every existing reader/test of `expression` is
     * untouched. Set via [setExpression]/[setExpressionPassive]/… — never alone,
     * or the two drift and we're back to a face with no provenance.
     */
    data class MoodReason(val why: String, val source: String, val atMs: Long)

    private val _moodReason = MutableStateFlow(
        MoodReason("I just started up", "boot", nowMs()),
    )
    val moodReason: StateFlow<MoodReason> = _moodReason.asStateFlow()

    /**
     * DECAY — a deliberate mood lives ~15s of QUIET, then rests to Neutral.
     *
     * Measured live twice before this existed: `curious` pinned for 88s,
     * `concerned` for 110s. The only escape was the 90s sleepy timer, whose
     * clock starts at the last settle and which is a STATE cue ("nobody's
     * around"), not mood decay — conflating the two is the original sin the
     * draft-1 plan named and the simplify pass wrongly deleted.
     *
     * Anchored to max(set-time, last settle): while the reply's audio still
     * plays there is no decay (state != Idle — the mood IS the reply's
     * expression), and the afterglow starts only once the dock goes quiet.
     * That answers the "wrong clock" objection that killed the parse-time TTL:
     * a 95s story keeps its face to the last word, then rests 15s later.
     *
     * One-shot job, not a ticker: an eternal `while(true)+delay` never lets a
     * test scheduler go idle, so runTest hangs forever draining it — the same
     * reason sleepyJob and winkJob are one-shots. Re-armed by every mood write
     * and by every settle; a firing that lands mid-speech simply stands down,
     * because the settle that ends the speech re-arms it. Room noise (userVoice)
     * writes nothing and so never disarms it (Fix 3's bug).
     */
    private var decayJob: Job? = null

    private fun scheduleDecay() {
        decayJob?.cancel()
        decayJob = null
        val r = _moodReason.value
        if (r.source !in decayingSources) return
        val wait = maxOf(r.atMs, lastSettledAtMs) + moodTtlMs - nowMs()
        decayJob = scope.launch {
            if (wait > 0) delay(wait)
            if (_state.value != FaceState.Idle) return@launch // the settle re-arms
            if (_expression.value == FaceExpression.Neutral) return@launch
            if (_moodReason.value.source !in decayingSources) return@launch
            writeExpression(
                FaceExpression.Neutral,
                "my last mood ran its course and I settled back to neutral",
                "decay",
            )
        }
    }

    /** One writer for the pair, so the mood and its reason can never disagree. */
    private fun writeExpression(e: FaceExpression, why: String, source: String) {
        _expression.value = e
        _moodReason.value = MoodReason(why, source, nowMs())
        scheduleDecay()
    }

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

    // Which face skin is showing. Drives FaceRegistry.byId in DockScreen + the
    // active voice profile. A live setFaceStyle (brain tool / dev picker) wins
    // over the pushed `faceStyle` config default until the next config push or
    // app restart — applyFaceStyleDefault yields to a sticky live choice.
    private val _faceId = MutableStateFlow(FaceRegistry.default.id)
    val faceId: StateFlow<String> = _faceId.asStateFlow()
    private var faceStyleSetLive = false

    /** Side-effect invoked whenever the active face changes (persist + re-voice).
     *  Set by the app; null in tests. */
    var onFaceStyleChanged: ((String) -> Unit)? = null

    /** Side-effect invoked whenever the mic mute changes (persist it so "mic off"
     *  survives an app restart). Set by the app; null in tests. */
    var onMicMutedChanged: ((Boolean) -> Unit)? = null

    // ── intents ──────────────────────────────────────────────────────

    fun wake() {
        wakeUp()
        // Clear stale emotion from the previous turn — listening should
        // start from a clean, attentive face, not whatever mood the LLM
        // last set.
        if (_expression.value != FaceExpression.Neutral &&
            _expression.value != FaceExpression.Wink
        ) {
            writeExpression(
                FaceExpression.Neutral,
                "I cleared my last mood when you got my attention",
                "wake",
            )
        }
        passiveLockUntilMs = nowMs() + STALE_GUARD_MS
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
        lastSettledAtMs = nowMs()   // the decay afterglow starts at the settle
        scheduleDecay()
        scheduleSleepy()
    }

    fun illustrate() {
        wakeUp()
        _state.value = FaceState.Illustrating
    }

    /**
     * VAD edge — who's making sound. Speech in the room OPENS the eyes, but must
     * not touch the sleepy timer.
     *
     * wakeUp() conflates two independent jobs: cancel the timer, and un-Sleepy the
     * face. This path wants only the second. Calling wakeUp() here cancelled the
     * timer on every VAD edge — including ambient room noise — with no matching
     * silence() to re-arm it, so one cough 30s after a turn killed the ONLY
     * time-based expression writer for good and pinned the last mood (usually
     * `curious`) until the next turn: the "face hangs for an hour" bug.
     *
     * But dropping the call outright left the dock visibly ASLEEP while someone
     * talked to it. VAD is LOCAL (PerceptionPipeline, on-device audio); listen()
     * is REMOTE-ONLY (renderConvMode ← convMode ← an inbound station frame), so
     * with the station down nothing else ever wakes the face. Reset the
     * expression, leave the timer armed — and if the room falls quiet again, the
     * still-pending timer puts it back to sleep on schedule.
     */
    fun userVoice(active: Boolean) {
        if (active && _expression.value == FaceExpression.Sleepy) {
            writeExpression(FaceExpression.Neutral, "I woke up when I heard someone talking", "voice")
        }
        _speaker.value = if (active) Speaker.User else Speaker.Silent
    }

    fun setGaze(offset: GazeOffset) { _gaze.value = offset }

    /**
     * An EXPLICIT mood — the brain's `set_face`, the dev panel, a test hook.
     *
     * [why] should be the setter's own account in the dock's voice ("it matched
     * what I was saying"). The LLM is the one setter that genuinely KNOWS its
     * reason, and today that reason is discarded at the exact moment it exists;
     * pass it through and the dock can answer "why do you look concerned?" from
     * its own record instead of inventing one.
     */
    @JvmOverloads
    fun setExpression(
        e: FaceExpression,
        why: String = "I set it deliberately, but didn't note why",
        source: String = "explicit",
    ) {
        // Cancel any in-flight wink restoration so the new explicit value sticks.
        winkJob?.cancel()
        winkJob = null
        writeExpression(e, why, source)
        // Explicit setExpression locks out passive (camera-mirror) updates
        // so the explicit choice doesn't get clobbered immediately.
        passiveLockUntilMs = nowMs() + passiveLockMs
    }

    /**
     * Update expression from a *passive* source (camera-driven emotion
     * mirroring). Ignored if a recent explicit [setExpression] is still
     * within its lock-out window — so the LLM's tool calls always win.
     * Also ignored during Speaking (the bot's expression should reflect
     * its own reply, not your face).
     */
    @JvmOverloads
    fun setExpressionPassive(
        e: FaceExpression,
        why: String = "I'm reacting to what I see on your face",
    ) {
        val now = nowMs()
        if (now < passiveLockUntilMs) return
        if (_state.value == FaceState.Speaking) return
        if (_expression.value == FaceExpression.Wink) return
        if (_expression.value == e) return
        // The reason NAMES THE CAUSE as the person, not the dock's own feeling —
        // that conflation is why it wore the user's anger and then denied being
        // angry. source="react" is what lets any reader tell a response-to-them
        // from a mood the dock chose itself. (The caller supplies `why`; see
        // EmotionReaction.reasonFor — e.g. "you look sad, so I'm concerned".)
        writeExpression(e, why, "react")
    }

    /**
     * Brief wink gesture. Sets expression to [FaceExpression.Wink] for
     * [holdMs], then restores whatever expression was active before.
     * Repeated calls reset the timer.
     */
    @JvmOverloads
    fun wink(holdMs: Long = 700L, why: String = "you said something funny") {
        val prev = _expression.value.takeUnless { it == FaceExpression.Wink }
            ?: FaceExpression.Neutral
        val prevReason = _moodReason.value
        winkJob?.cancel()
        writeExpression(FaceExpression.Wink, "I winked — $why", "wink")
        winkJob = scope.launch {
            delay(holdMs)
            // Restore the mood AND the reason it had — a wink is a brief overlay,
            // so the face it returns to keeps its original story, not the wink's.
            _expression.value = prev
            _moodReason.value = prevReason
            scheduleDecay() // re-arm for the restored mood (anchor = its original atMs)
        }
    }

    /**
     * Switch the active face skin (brain `set_face_style` tool / dev picker).
     * Returns false (no-op) for an unknown id. This is a LIVE choice and sticks
     * over the config default until app restart.
     */
    fun setFaceStyle(id: String): Boolean {
        if (!FaceRegistry.isKnown(id)) return false
        faceStyleSetLive = true
        if (_faceId.value != id) {
            _faceId.value = id
            onFaceStyleChanged?.invoke(id)
        }
        return true
    }

    /**
     * Apply the station-pushed `faceStyle` default. Ignored once a live
     * [setFaceStyle] has set the face this session, so a user/brain override
     * isn't clobbered by a stale config push.
     */
    fun applyFaceStyleDefault(id: String) {
        if (faceStyleSetLive) return
        if (!FaceRegistry.isKnown(id)) return
        if (_faceId.value != id) {
            _faceId.value = id
            onFaceStyleChanged?.invoke(id)
        }
    }

    /** Restore a persisted face id at startup (counts as the live baseline so a
     *  later default push doesn't override the user's last choice). */
    fun restoreFaceStyle(id: String?) {
        if (id != null && FaceRegistry.isKnown(id)) {
            faceStyleSetLive = true
            _faceId.value = id
            onFaceStyleChanged?.invoke(id)
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

    /** Seed the mic mute from persisted state at startup (so "mic off" survives an
     *  app restart). Does NOT fire onMicMutedChanged — it's a restore, not a change. */
    fun restoreMicMuted(muted: Boolean) {
        _micMuted.value = muted
        syncPrivacyAndSpeaker()
    }

    private fun setMicMuted(muted: Boolean) {
        _micMuted.value = muted
        onMicMutedChanged?.invoke(muted)
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
            writeExpression(FaceExpression.Neutral, "I woke back up", "wake")
        }
    }

    private fun scheduleSleepy() {
        sleepyJob?.cancel()
        sleepyJob = scope.launch {
            delay(sleepyAfterMs)
            if (_state.value == FaceState.Idle &&
                _expression.value != FaceExpression.Sleepy
            ) {
                writeExpression(
                    FaceExpression.Sleepy,
                    "nothing's happened for a while, so I got sleepy",
                    "timer",
                )
            }
        }
    }
}
