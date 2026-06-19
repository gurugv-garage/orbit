package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.runTest
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PerceptionWiringTest {

    @org.junit.Before
    fun setUp() {
        // FaceController.silence()/wakeUp() schedule the sleepy-timer on Main — the
        // A1.2 timeout/transcript paths call silence(), so Main must be a test one.
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @org.junit.After
    fun tearDown() = Dispatchers.resetMain()

    // A1.2: a tap (WakeWord) shows the Listening face as an "addressed" ack. It
    // stays Listening until either a final transcript (server sentence-end) or an
    // ~8s no-speech timeout — so we must NOT advanceUntilIdle (that jumps past the
    // timeout). advanceTimeBy a small amount keeps us inside the ack window.
    @Test
    fun wakeWordEventDrivesControllerWake() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.WakeWord("hey jarvis"))
        advanceTimeBy(100) // inside the ack window, before the no-speech timeout

        assertThat(controller.state.value).isEqualTo(FaceState.Listening)

        scope.cancel()
    }

    // A1.2 variant: tap-but-no-speech → after the timeout, the face drops to Idle
    // (so a stray tap can't leave it stuck Listening forever).
    @Test
    fun wakeWordWithoutSpeechTimesOutToIdle() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.WakeWord("(tap)"))
        advanceTimeBy(100)
        assertThat(controller.state.value).isEqualTo(FaceState.Listening)

        advanceTimeBy(9_000) // past the ~8s no-speech timeout
        assertThat(controller.state.value).isEqualTo(FaceState.Idle)

        scope.cancel()
    }

    // A1.2 variant: tap → a final transcript (server sentence-end) resolves the
    // Listening face (the normal path; clears the timeout).
    @Test
    fun finalTranscriptClearsListeningFace() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.WakeWord("(tap)"))
        advanceTimeBy(100)
        assertThat(controller.state.value).isEqualTo(FaceState.Listening)

        PerceptionBus.emit(PerceptionEvent.Transcript("what time is it", isFinal = true))
        advanceTimeBy(100)
        assertThat(controller.state.value).isEqualTo(FaceState.Idle)

        // and the no-speech timeout must NOT later re-fire (it was cancelled).
        advanceTimeBy(9_000)
        assertThat(controller.state.value).isEqualTo(FaceState.Idle)

        scope.cancel()
    }

    @Test
    fun voiceActivityFlipsSpeakerToUser() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.VoiceActivity(active = true, probability = 0.9f))
        advanceUntilIdle()
        assertThat(controller.speaker.value).isEqualTo(Speaker.User)

        PerceptionBus.emit(PerceptionEvent.VoiceActivity(active = false, probability = 0.1f))
        advanceUntilIdle()
        assertThat(controller.speaker.value).isEqualTo(Speaker.Silent)

        scope.cancel()
    }

    @Test
    fun audioLevelUpdatesWiringState() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.AudioLevel(0.6f))
        advanceUntilIdle()
        assertThat(wiring.audioLevel.value).isWithin(0.001f).of(0.6f)

        scope.cancel()
    }

    @Test
    fun transcriptUpdatesWiringSnapshot() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.Transcript("hello", isFinal = false))
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEqualTo("hello")
        assertThat(wiring.transcript.value.isFinal).isFalse()

        PerceptionBus.emit(PerceptionEvent.Transcript("hello world", isFinal = true))
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEqualTo("hello world")
        assertThat(wiring.transcript.value.isFinal).isTrue()

        scope.cancel()
    }

    @Test
    fun wakeWordClearsTranscriptForNewTurn() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.Transcript("previous turn", isFinal = true))
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEqualTo("previous turn")

        PerceptionBus.emit(PerceptionEvent.WakeWord("hey jarvis"))
        advanceTimeBy(100) // inside the ack window (don't trip the no-speech timeout)
        assertThat(wiring.transcript.value.text).isEmpty()

        scope.cancel()
    }
}
