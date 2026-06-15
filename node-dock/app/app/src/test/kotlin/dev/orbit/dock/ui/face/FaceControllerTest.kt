package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
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
