package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * Face transition tests, RENDERER model: the STATION owns the conversation state
 * machine and emits the mode; PerceptionWiring renders it onto the face. So we
 * drive the convMode flow through a realistic turn sequence and assert the face
 * lands correctly at each step. (The state-machine logic itself is tested on the
 * station: ConversationState. The old per-shot-recognizer / session_ended cases
 * are gone with the local recognizer.)
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PerceptionWiringTransitionTest {

    @Before
    fun setUp() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun fixture(scheduler: kotlinx.coroutines.test.TestCoroutineScheduler):
        Triple<FaceController, MutableStateFlow<String>, PerceptionWiring> {
        val controller = FaceController()
        val conv = MutableStateFlow("idle")
        val wiring = PerceptionWiring(controller, convMode = conv)
        wiring.attach(CoroutineScope(UnconfinedTestDispatcher(scheduler)))
        return Triple(controller, conv, wiring)
    }

    // canonical turn: idle → listening (tap) → thinking → speaking → followup → idle.
    @Test
    fun fullTurn_idle_listen_speak_followup_idle() = runTest {
        val (c, conv, _) = fixture(testScheduler)
        assertThat(c.state.value).isEqualTo(FaceState.Idle)

        conv.value = "listening"; advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)

        // station runs the turn; the agent turn drives Speaking via the TTS callback
        // (here we just assert the renderer doesn't fight it: a thinking mode doesn't
        // force the face out of whatever the turn set). Render thinking → not listening.
        conv.value = "thinking"; advanceUntilIdle()
        assertThat(c.state.value).isNotEqualTo(FaceState.Listening)

        // reply done → followup (auto re-listen) → listening face again.
        conv.value = "followup"; advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)

        // follow-up window closes → idle.
        conv.value = "idle"; advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    // multi-turn follow-up chain: listening↔idle through several loops.
    @Test
    fun followupChainRendersListeningEachLoop() = runTest {
        val (c, conv, _) = fixture(testScheduler)
        repeat(3) {
            conv.value = "followup"; advanceUntilIdle()
            assertThat(c.state.value).isEqualTo(FaceState.Listening)
            conv.value = "thinking"; advanceUntilIdle()  // user followed up → a turn
            conv.value = "speaking"; advanceUntilIdle()
        }
    }

    // idempotent: re-emitting the same mode doesn't thrash the face.
    @Test
    fun sameModeRepeatedIsStable() = runTest {
        val (c, conv, _) = fixture(testScheduler)
        conv.value = "listening"; advanceUntilIdle()
        conv.value = "listening"; advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)
    }

    // BUG-2: mic OFF ⇒ NOT listening. The local guard refuses the station's
    // listening/followup glow while muted, even if a frame arrives late.
    private fun mutedFixture(scheduler: kotlinx.coroutines.test.TestCoroutineScheduler):
        Triple<FaceController, MutableStateFlow<String>, MutableStateFlow<Boolean>> {
        val controller = FaceController()
        val conv = MutableStateFlow("idle")
        val muted = MutableStateFlow(false)
        val wiring = PerceptionWiring(controller, convMode = conv, micMuted = muted)
        wiring.attach(CoroutineScope(UnconfinedTestDispatcher(scheduler)))
        return Triple(controller, conv, muted)
    }

    @Test
    fun mutedRefusesListeningGlow() = runTest {
        val (c, conv, muted) = mutedFixture(testScheduler)
        muted.value = true
        // A late/racing listening frame must NOT flip the face to Listening while muted.
        conv.value = "listening"; advanceUntilIdle()
        assertThat(c.state.value).isNotEqualTo(FaceState.Listening)
        conv.value = "followup"; advanceUntilIdle()
        assertThat(c.state.value).isNotEqualTo(FaceState.Listening)
    }

    @Test
    fun unmutedListensAgain() = runTest {
        val (c, conv, muted) = mutedFixture(testScheduler)
        muted.value = true
        conv.value = "listening"; advanceUntilIdle()
        assertThat(c.state.value).isNotEqualTo(FaceState.Listening)
        // Unmute, then a fresh listening frame → the glow returns.
        muted.value = false
        conv.value = "idle"; advanceUntilIdle()
        conv.value = "listening"; advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)
    }
}
