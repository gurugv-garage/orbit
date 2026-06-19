package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * Foolproof state-transition tests for the face: drive realistic *sequences*
 * of PerceptionBus events (exactly what the pipeline emits during a turn) and
 * assert the FaceState lands correctly at each step.
 *
 * These pin the cross-machine invariants documented in LIFECYCLE.md — most
 * importantly the no-flicker rule (per-shot recognizer errors must NOT drop
 * the face out of Listening) and that the face always settles to Idle when a
 * session truly ends.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PerceptionWiringTransitionTest {

    @Before
    fun setUp() {
        // FaceController.silence()/wake() schedule the sleepy-timer on Main.
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun fixture(scheduler: kotlinx.coroutines.test.TestCoroutineScheduler):
        Pair<FaceController, PerceptionWiring> {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        wiring.attach(CoroutineScope(UnconfinedTestDispatcher(scheduler)))
        return controller to wiring
    }

    // ── the canonical voice turn ─────────────────────────────────────────

    @Test
    fun fullVoiceTurn_idle_listen_speak_idle() = runTest {
        val (c, _) = fixture(testScheduler)
        assertThat(c.state.value).isEqualTo(FaceState.Idle)

        // tap → Listening ack (A1.2). advanceTimeBy inside the ack window, NOT
        // advanceUntilIdle — the latter trips the ~8s no-speech timeout to Idle.
        PerceptionBus.emit(PerceptionEvent.WakeWord("(tap)"))
        advanceTimeBy(100)
        assertThat(c.state.value).isEqualTo(FaceState.Listening)

        // server final transcript (the VAD sentence-end) clears Listening; the
        // agent turn then drives the face. STT is server-side now — there's no
        // local SttListening(armed=false); the final transcript is the signal.
        PerceptionBus.emit(PerceptionEvent.Transcript("hi", isFinal = true))
        advanceTimeBy(100)
        assertThat(c.state.value).isEqualTo(FaceState.Idle)

        // dock speaks (agent turn)
        c.speak()
        advanceTimeBy(100)
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)

        // TTS finishes → silence → Idle
        c.silence()
        advanceTimeBy(100)
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    // ── the no-flicker invariant ─────────────────────────────────────────

    @Test
    fun perShotErrorDoesNotDropFaceFromListening() = runTest {
        val (c, _) = fixture(testScheduler)
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)

        // SR shot ends with no-match (normal). Must NOT change face state.
        PerceptionBus.emit(PerceptionEvent.Error("speech-recognizer", RuntimeException("no match")))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)
    }

    @Test
    fun perShotFinalStatusDoesNotDropFace() = runTest {
        val (c, _) = fixture(testScheduler)
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
        advanceUntilIdle()

        // A per-shot "final" (one attempt ended) is NOT session end.
        PerceptionBus.emit(PerceptionEvent.Status("speech-recognizer", "final"))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)
    }

    @Test
    fun sessionEndedReturnsFaceToIdleExactlyFromListening() = runTest {
        val (c, _) = fixture(testScheduler)
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)

        PerceptionBus.emit(PerceptionEvent.Status("speech-recognizer", "session_ended"))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
    }

    @Test
    fun sessionEndedWhileSpeakingDoesNotInterruptSpeech() = runTest {
        val (c, _) = fixture(testScheduler)
        // Dock is mid-reply.
        c.speak()
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)

        // A late session_ended must NOT yank Speaking → Idle (only Listening/
        // Engaged are returned to Idle by session_ended).
        PerceptionBus.emit(PerceptionEvent.Status("speech-recognizer", "session_ended"))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Speaking)
    }

    // ── tap-to-stop ──────────────────────────────────────────────────────

    @Test
    fun stopListeningSilencesFaceAndClearsArmed() = runTest {
        val (c, w) = fixture(testScheduler)
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Listening)
        assertThat(w.sttArmed.value).isTrue()

        PerceptionBus.emit(PerceptionEvent.StopListening)
        advanceUntilIdle()
        assertThat(c.state.value).isEqualTo(FaceState.Idle)
        assertThat(w.sttArmed.value).isFalse()
    }

    // ── sttArmed honesty (UI text source) ────────────────────────────────

    @Test
    fun sttArmedTracksArmDisarmHonestly() = runTest {
        val (_, w) = fixture(testScheduler)
        assertThat(w.sttArmed.value).isFalse()

        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
        advanceUntilIdle()
        assertThat(w.sttArmed.value).isTrue()

        PerceptionBus.emit(PerceptionEvent.SttListening(armed = false))
        advanceUntilIdle()
        assertThat(w.sttArmed.value).isFalse()
    }

    @Test
    fun sessionEndedClearsArmed() = runTest {
        val (_, w) = fixture(testScheduler)
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
        advanceUntilIdle()
        assertThat(w.sttArmed.value).isTrue()

        PerceptionBus.emit(PerceptionEvent.Status("speech-recognizer", "session_ended"))
        advanceUntilIdle()
        assertThat(w.sttArmed.value).isFalse()
    }

    // ── two turns in a row (continuous conversation shape) ───────────────

    @Test
    fun twoConsecutiveTurnsEachReachListeningThenSpeaking() = runTest {
        val (c, _) = fixture(testScheduler)
        repeat(2) {
            // tap → Listening ack (A1.2; advanceTimeBy keeps us in the ack window).
            PerceptionBus.emit(PerceptionEvent.WakeWord("(turn)"))
            advanceTimeBy(100)
            assertThat(c.state.value).isEqualTo(FaceState.Listening)

            // server final transcript clears Listening; the agent turn speaks.
            PerceptionBus.emit(PerceptionEvent.Transcript("x", isFinal = true))
            c.speak()
            advanceTimeBy(100)
            assertThat(c.state.value).isEqualTo(FaceState.Speaking)

            c.silence()
            advanceTimeBy(100)
            assertThat(c.state.value).isEqualTo(FaceState.Idle)
        }
    }
}
