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
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PerceptionWiringTest {

    @Test
    fun wakeWordEventDrivesControllerWake() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.WakeWord("hey jarvis"))
        advanceUntilIdle()

        // Tap-to-listen: WakeWord arms STT directly, so the face goes straight
        // to Listening (not the older two-stage Engaged → Listening).
        assertThat(controller.state.value).isEqualTo(FaceState.Listening)

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
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEmpty()

        scope.cancel()
    }
}
