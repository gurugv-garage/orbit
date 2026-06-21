package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Test

/**
 * PerceptionWiring is now a PURE RENDERER of the station's conversation mode +
 * a reporter of raw events up. So these tests verify two contracts:
 *   1. RENDER: convMode flow ("listening"/"idle"/…) → face listen()/silence().
 *   2. REPORT: tap → onWake(); FaceSeen → sendFaceArrival(); FaceLost →
 *      sendFaceLeft(); VoiceActivity → sendVad(). No local listening DECISIONS.
 * (The listening STATE MACHINE itself is tested on the station: ConversationState.)
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PerceptionWiringTest {

    @org.junit.Before
    fun setUp() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @org.junit.After
    fun tearDown() = Dispatchers.resetMain()

    // ── 1. RENDER: convMode drives the face ───────────────────────────────────

    @Test
    fun convModeListeningDrivesFaceListening() = runTest {
        val controller = FaceController()
        val conv = MutableStateFlow("idle")
        val wiring = PerceptionWiring(controller, convMode = conv)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        conv.value = "listening"
        advanceUntilIdle()
        assertThat(controller.state.value).isEqualTo(FaceState.Listening)

        conv.value = "idle"
        advanceUntilIdle()
        assertThat(controller.state.value).isEqualTo(FaceState.Idle)
        scope.cancel()
    }

    @Test
    fun convModeFollowupAlsoRendersListening() = runTest {
        val controller = FaceController()
        val conv = MutableStateFlow("idle")
        val wiring = PerceptionWiring(controller, convMode = conv)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        conv.value = "followup" // auto re-listen window → also a listening face
        advanceUntilIdle()
        assertThat(controller.state.value).isEqualTo(FaceState.Listening)
        scope.cancel()
    }

    // ── 2. REPORT: events go UP, no local decisions ───────────────────────────

    @Test
    fun tapReportsUpViaOnWake() = runTest {
        var woke = 0
        val controller = FaceController()
        val wiring = PerceptionWiring(controller, onWake = { woke++ })
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.WakeWord("(tap)"))
        advanceUntilIdle()
        assertThat(woke).isEqualTo(1) // → agent.addressed() (the station toggles)
        scope.cancel()
    }

    @Test
    fun faceSeenReportsArrivalUpOnceOnTheEdge() = runTest {
        var arrivals = 0
        val controller = FaceController()
        val wiring = PerceptionWiring(controller, sendFaceArrival = { arrivals++ })
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.1f))
        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.1f)) // still present → no 2nd arrival
        advanceUntilIdle()
        assertThat(arrivals).isEqualTo(1)
        scope.cancel()
    }

    @Test
    fun faceLostReportsLeftUp() = runTest {
        var left = 0
        val controller = FaceController()
        val wiring = PerceptionWiring(controller, sendFaceLeft = { left++ })
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.FaceLost)
        advanceUntilIdle()
        assertThat(left).isEqualTo(1)
        scope.cancel()
    }

    @Test
    fun voiceActivityReportsVadUp() = runTest {
        var vad = 0
        val controller = FaceController()
        val wiring = PerceptionWiring(controller, sendVad = { vad++ })
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.VoiceActivity(active = true, probability = 0.9f))
        advanceUntilIdle()
        assertThat(vad).isEqualTo(1)
        assertThat(controller.speaker.value).isEqualTo(Speaker.User)

        // inactive VAD doesn't report (only onset extends a window)
        PerceptionBus.emit(PerceptionEvent.VoiceActivity(active = false, probability = 0.1f))
        advanceUntilIdle()
        assertThat(vad).isEqualTo(1)
        assertThat(controller.speaker.value).isEqualTo(Speaker.Silent)
        scope.cancel()
    }

    // ── unchanged: transcript + audio-level rendering ─────────────────────────

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
        PerceptionBus.emit(PerceptionEvent.Transcript("hello world", isFinal = true))
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEqualTo("hello world")
        scope.cancel()
    }

    @Test
    fun tapClearsTranscriptForNewTurn() = runTest {
        val controller = FaceController()
        val wiring = PerceptionWiring(controller)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)
        PerceptionBus.emit(PerceptionEvent.Transcript("previous turn", isFinal = true))
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEqualTo("previous turn")
        PerceptionBus.emit(PerceptionEvent.WakeWord("(tap)"))
        advanceUntilIdle()
        assertThat(wiring.transcript.value.text).isEmpty()
        scope.cancel()
    }
}
