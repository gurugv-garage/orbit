package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class FaceControllerTest {

    @Before
    fun setUp() {
        // FaceController launches a sleepy-timer coroutine on Dispatchers.Main
        // (silence/togglePrivacy/scheduleSleepy). Provide a test dispatcher.
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun startsIdleAndSilent() {
        val c = FaceController()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
        assertThat(c.speaker.value).isEqualTo(Speaker.Silent)
        assertThat(c.privacy.value).isFalse()
    }

    @Test
    fun wakeFromIdleMovesToEngaged() {
        val c = FaceController()
        c.wake()
        assertThat(c.state.value).isEqualTo(FaceState.Engaged)
    }

    @Test
    fun wakeFromNonIdleIsNoOp() {
        val c = FaceController()
        c.wake()
        c.speak()
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)
        c.wake()
        // still Speaking — wake only fires from Idle
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)
    }

    @Test
    fun listenSwitchesState() {
        val c = FaceController()
        c.wake()
        c.listen()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)
    }

    @Test
    fun speakAlsoFlipsSpeakerToBot() {
        val c = FaceController()
        c.speak()
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)
        assertThat(c.speaker.value).isEqualTo(Speaker.Bot)
    }

    @Test
    fun silenceReturnsToIdleAndClearsSpeaker() {
        val c = FaceController()
        c.speak()
        c.silence()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
        assertThat(c.speaker.value).isEqualTo(Speaker.Silent)
    }

    @Test
    fun userVoiceTogglesSpeakerOnly() {
        val c = FaceController()
        c.userVoice(true)
        assertThat(c.speaker.value).isEqualTo(Speaker.User)
        assertThat(c.state.value).isEqualTo(FaceState.Idle) // unchanged
        c.userVoice(false)
        assertThat(c.speaker.value).isEqualTo(Speaker.Silent)
    }

    /**
     * Fix 4: every mood carries a reason. This is the "angry but it says it's
     * not angry" bug: the camera put a mood on the dock, the LLM was told only
     * "angry", and — having no reason — it invented one ("my internal feelings
     * show up automatically").
     */
    @Test
    fun everyMoodCarriesItsReasonAndAnExplicitMoodOutranksTheCamera() {
        val c = FaceController(dispatcher = UnconfinedTestDispatcher())

        c.setExpression(FaceExpression.Concerned, why = "you said the deploy failed", source = "llm")
        assertThat(c.moodReason.value.why).isEqualTo("you said the deploy failed")
        assertThat(c.moodReason.value.source).isEqualTo("llm")

        // An explicit mood LOCKS OUT the camera for ~2.5s (passiveLockUntilMs), so
        // the LLM's choice isn't clobbered the instant it lands. Verified here
        // rather than assumed — the first cut of this test mirrored immediately
        // and failed on exactly this.
        c.setExpressionPassive(FaceExpression.Angry)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Concerned)
        assertThat(c.moodReason.value.source).isEqualTo("llm")
    }

    /**
     * Once the lock lapses the camera CAN write, and what it writes is tagged
     * source="react" — a response to the person, not a mood the dock chose. That
     * tag is what stops the LLM claiming it as its own feeling.
     */
    @Test
    fun aCameraReactionIsMarkedAsAReactionOnceTheExplicitLockLapses() {
        val c = FaceController(dispatcher = UnconfinedTestDispatcher())
        // No prior explicit mood → no lock. The camera sees the user is angry.
        c.setExpressionPassive(FaceExpression.Angry)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Angry)
        assertThat(c.moodReason.value.source).isEqualTo("react")
    }

    /**
     * A mood nobody deliberately chose must not borrow the brain's voice.
     *
     * Caught live on build 39: `face_force` (a debug hook) routed through
     * setFace's defaults, so the probe reported source=llm / "it matched what I
     * was saying" for a face a TEST had pushed. The dock would have told you the
     * LLM chose it. That is a confabulation planted by the very change meant to
     * end confabulation — the failure mode is that convenient defaults lie.
     */
    @Test
    fun aMoodFromANonBrainSourceNeverClaimsTheBrainChoseIt() {
        val c = FaceController(dispatcher = UnconfinedTestDispatcher())
        c.setExpression(FaceExpression.Sad, why = "someone forced this from a debug tool", source = "debug")
        assertThat(c.moodReason.value.source).isEqualTo("debug")
        assertThat(c.moodReason.value.why).doesNotContain("what I was saying")
    }

    /**
     * THE decay — the actual fix for the reported symptom ("curious hung for an
     * hour"; measured live: curious 88s, concerned 110s, with only the 90s
     * sleepy timer as an escape). A deliberate mood lives 15s of QUIET: it must
     * HOLD for the whole reply, however long the audio runs, then rest 15s
     * after the settle. nowMs is injected as virtual time — on the wall clock
     * these assertions would pass vacuously (advanceTimeBy moves the scheduler,
     * not the clock).
     */
    @Test
    fun anLlmMoodDecaysAfterTheSettleNotWhileSpeaking() = runTest {
        val c = FaceController(
            dispatcher = StandardTestDispatcher(testScheduler),
            nowMs = { testScheduler.currentTime },
        )
        c.setExpression(FaceExpression.Concerned, why = "you said the deploy failed", source = "llm")
        c.speak()
        advanceTimeBy(95_000) // a turn-75cb44ad-length reply: mood holds throughout
        assertThat(c.expression.value).isEqualTo(FaceExpression.Concerned)

        c.silence()
        advanceTimeBy(14_000) // afterglow not over yet
        assertThat(c.expression.value).isEqualTo(FaceExpression.Concerned)
        advanceTimeBy(3_000)  // 15s of quiet → rest
        assertThat(c.expression.value).isEqualTo(FaceExpression.Neutral)
        assertThat(c.moodReason.value.source).isEqualTo("decay")
    }

    /** A camera reaction decays too: the gate re-reacts only on a CHANGE of
     *  read, so a reaction to someone who then walks away would pin forever —
     *  the same hang class as the LLM moods. */
    @Test
    fun aCameraReactionDecaysAfterTheAfterglow() = runTest {
        val c = FaceController(
            dispatcher = StandardTestDispatcher(testScheduler),
            nowMs = { testScheduler.currentTime },
        )
        c.setExpressionPassive(FaceExpression.Happy)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Happy)
        advanceTimeBy(16_000)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Neutral)
        assertThat(c.moodReason.value.source).isEqualTo("decay")
    }

    /** Resting states never decay — only deliberate moods do. Sleepy (the 90s
     *  timer) must be able to sit indefinitely. */
    @Test
    fun restingStatesDoNotDecay() = runTest {
        val c = FaceController(
            dispatcher = StandardTestDispatcher(testScheduler),
            nowMs = { testScheduler.currentTime },
        )
        c.silence()
        advanceTimeBy(91_000)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Sleepy)
        advanceTimeBy(60_000)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Sleepy)
    }

    /** A wink is a brief overlay: the face it restores keeps its ORIGINAL story,
     *  not the wink's — otherwise a joke rewrites why the dock looks concerned. */
    @Test
    fun winkRestoresThePriorMoodAndItsReason() = runTest {
        val c = FaceController(dispatcher = StandardTestDispatcher(testScheduler))
        c.setExpression(FaceExpression.Concerned, why = "you sounded worried", source = "llm")
        c.wink(holdMs = 100L, why = "you made a joke")
        assertThat(c.expression.value).isEqualTo(FaceExpression.Wink)

        advanceTimeBy(200)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Concerned)
        assertThat(c.moodReason.value.why).isEqualTo("you sounded worried")
        assertThat(c.moodReason.value.source).isEqualTo("llm")
    }

    /**
     * The OTHER half of wakeUp(), which the first cut of the hour-hang fix threw
     * away with the timer: waking a SLEEPY face when someone actually speaks.
     *
     * VAD is LOCAL (PerceptionPipeline emits off on-device audio); listen() is
     * REMOTE-ONLY (renderConvMode ← convMode ← an inbound station frame). So with
     * the station down/slow, the dock used to wake on your voice and — after the
     * naive fix — sat there visibly asleep while you talked to it. Reset the
     * expression WITHOUT touching the timer: the two jobs are independent.
     */
    @Test
    fun userVoiceWakesASleepyFaceWithoutTheStation() = runTest {
        val c = FaceController(dispatcher = StandardTestDispatcher(testScheduler))
        c.silence()
        advanceTimeBy(91_000)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Sleepy)

        // Someone speaks. No station, so no conv-mode / listen() will ever arrive.
        c.userVoice(true)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Neutral)
    }

    /**
     * The "face hangs for an hour" regression. userVoice fires on EVERY VAD edge,
     * including ambient room noise the dock isn't addressed by, and nothing
     * re-arms the sleepy timer afterwards. It used to call wakeUp(), which
     * cancels that timer — so one cough after a turn killed the only time-based
     * expression writer for good and pinned the last mood forever.
     *
     * "Speaker ONLY" is what the test above always claimed; it only ever checked
     * `state`, never the timer that was actually being destroyed. This asserts
     * the timer survives — the part that was really broken.
     */
    @Test
    fun userVoiceDoesNotCancelThePendingSleepyTransition() = runTest {
        val c = FaceController(dispatcher = StandardTestDispatcher(testScheduler))
        c.setExpression(FaceExpression.Curious)
        c.silence() // end of turn → sleepy armed

        // Ambient room noise, well before the 90s sleepy deadline.
        advanceTimeBy(30_000)
        c.userVoice(true)
        c.userVoice(false)

        // The timer must still fire. Before the fix it was cancelled here and
        // Curious stayed pinned indefinitely.
        advanceTimeBy(70_000)
        assertThat(c.expression.value).isEqualTo(FaceExpression.Sleepy)
    }

    @Test
    fun privacyToggleMutes() {
        val c = FaceController()
        c.speak()
        c.togglePrivacy()
        assertThat(c.privacy.value).isTrue()
        assertThat(c.speaker.value).isEqualTo(Speaker.Muted)
        assertThat(c.state.value).isEqualTo(FaceState.Idle)

        c.togglePrivacy()
        assertThat(c.privacy.value).isFalse()
        assertThat(c.speaker.value).isEqualTo(Speaker.Silent)
    }

    @Test
    fun gazeAndExpressionStoreLatest() {
        val c = FaceController()
        c.setGaze(GazeOffset(0.3f, -0.5f))
        c.setExpression(FaceExpression.Curious)
        assertThat(c.gaze.value).isEqualTo(GazeOffset(0.3f, -0.5f))
        assertThat(c.expression.value).isEqualTo(FaceExpression.Curious)
    }

    // ── transition completeness: silence() always reaches Idle ───────────
    // Whatever state we're in, a tap-stop / barge-in / turn-end must land at
    // Idle. This is the safety net that prevents a stuck face.

    @Test
    fun silenceFromListeningReachesIdle() {
        val c = FaceController()
        c.listen()
        c.silence()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    @Test
    fun silenceFromSpeakingReachesIdle() {
        val c = FaceController()
        c.speak()
        c.silence()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    @Test
    fun silenceFromEngagedReachesIdle() {
        val c = FaceController()
        c.wake()
        c.silence()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    @Test
    fun silenceFromIdleStaysIdle() {
        val c = FaceController()
        c.silence()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    @Test
    fun listenThenSpeakIsAllowed_speakWins() {
        // Mid-listen the dock decides to speak (e.g. immediate reply). Speaking
        // must take over cleanly.
        val c = FaceController()
        c.listen()
        c.speak()
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)
        assertThat(c.speaker.value).isEqualTo(Speaker.Bot)
    }

    @Test
    fun rapidListenSpeakSilenceSequenceEndsIdle() {
        // Hammer the transitions; end state must be deterministic.
        val c = FaceController()
        repeat(10) {
            c.listen()
            c.speak()
            c.silence()
        }
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
        assertThat(c.speaker.value).isEqualTo(Speaker.Silent)
    }

    // ── face style ───────────────────────────────────────────────────────

    @Test
    fun defaultFaceIsAurora() {
        val c = FaceController()
        assertThat(c.faceId.value).isEqualTo(FaceRegistry.default.id)
        assertThat(c.faceId.value).isEqualTo("aurora")
    }

    @Test
    fun setFaceStyleSwitchesAndFiresCallback() {
        val c = FaceController()
        val seen = mutableListOf<String>()
        c.onFaceStyleChanged = { seen.add(it) }

        assertThat(c.setFaceStyle("vader")).isTrue()
        assertThat(c.faceId.value).isEqualTo("vader")
        assertThat(seen).containsExactly("vader")
    }

    @Test
    fun unknownFaceStyleIsRejected() {
        val c = FaceController()
        assertThat(c.setFaceStyle("godzilla")).isFalse()
        assertThat(c.faceId.value).isEqualTo("aurora")
    }

    @Test
    fun liveChoiceWinsOverConfigDefault() {
        val c = FaceController()
        c.setFaceStyle("puppy")              // live override this session
        c.applyFaceStyleDefault("robot")     // a config push arrives
        assertThat(c.faceId.value).isEqualTo("puppy")
    }

    @Test
    fun configDefaultAppliesWhenNoLiveChoice() {
        val c = FaceController()
        c.applyFaceStyleDefault("owl")
        assertThat(c.faceId.value).isEqualTo("owl")
    }

    @Test
    fun restoredChoiceIsStickyOverDefault() {
        val c = FaceController()
        c.restoreFaceStyle("ghost")
        c.applyFaceStyleDefault("robot")
        assertThat(c.faceId.value).isEqualTo("ghost")
    }
}
