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
        // FaceSeen no longer reports arrival DIRECTLY — it routes through the
        // PresenceGate (NEAR + CENTERED + SUSTAINED), which only fires ARRIVE once,
        // on the settled edge. So the report needs a NEAR+CENTERED face held for
        // SUSTAIN_MS, and must fire EXACTLY ONCE no matter how many frames follow.
        // We drive the gate's clock deterministically via the injected nowMs.
        var arrivals = 0
        var clock = 0L
        val controller = FaceController()
        val wiring = PerceptionWiring(
            controller, sendFaceArrival = { arrivals++ }, nowMs = { clock },
        )
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        // A near (size ≥ 0.22) + centered face. First frame starts the sustain
        // timer; not yet long enough → no arrival. (Base clock is non-zero: the
        // gate uses 0L as the "no timer" sentinel for qualifyingSince.)
        clock = 10_000L
        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.3f))
        advanceUntilIdle()
        assertThat(arrivals).isEqualTo(0)

        // Past SUSTAIN_MS (1500 ms) of continuous qualifying → ARRIVE fires once.
        clock = 11_600L
        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.3f))
        advanceUntilIdle()
        assertThat(arrivals).isEqualTo(1)

        // Still present → no second arrival.
        clock = 12_000L
        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.3f))
        advanceUntilIdle()
        assertThat(arrivals).isEqualTo(1)
        scope.cancel()
    }

    @Test
    fun faceLostReportsLeftUpAfterArrival() = runTest {
        // LEAVE is debounced and only meaningful AFTER an arrival: a bare FaceLost
        // with no prior settled face produces nothing (the gate isn't "present").
        // So: settle a face (ARRIVE), then FaceLost past the LEAVE_GRACE_MS window
        // → exactly one LEAVE report.
        var left = 0
        var clock = 0L
        val controller = FaceController()
        val wiring = PerceptionWiring(controller, sendFaceLeft = { left++ }, nowMs = { clock })
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        // Settle a near+centered face so the gate is "present" (base clock non-zero
        // — the gate uses 0L as its "no timer" sentinel).
        clock = 10_000L
        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.3f))
        clock = 11_600L // past SUSTAIN_MS → ARRIVE (we don't assert it here)
        PerceptionBus.emit(PerceptionEvent.FaceSeen(0f, 0f, 0.3f))
        advanceUntilIdle()

        // First FaceLost starts the leave-grace timer; not yet elapsed → no LEAVE.
        clock = 11_700L
        PerceptionBus.emit(PerceptionEvent.FaceLost)
        advanceUntilIdle()
        assertThat(left).isEqualTo(0)

        // Past LEAVE_GRACE_MS (2000 ms) since qualifying stopped → LEAVE fires once.
        clock = 14_000L
        PerceptionBus.emit(PerceptionEvent.FaceLost)
        advanceUntilIdle()
        assertThat(left).isEqualTo(1)
        scope.cancel()
    }

    @Test
    fun bareFaceLostWithoutArrivalReportsNothing() = runTest {
        // Guard the gate contract: a FaceLost with no prior settled presence is a
        // no-op (someone glimpsed at the edge / a flicker, never "here").
        var left = 0
        val controller = FaceController()
        val wiring = PerceptionWiring(controller, sendFaceLeft = { left++ }, nowMs = { 0L })
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        wiring.attach(scope)

        PerceptionBus.emit(PerceptionEvent.FaceLost)
        advanceUntilIdle()
        assertThat(left).isEqualTo(0)
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

        // BOTH VAD edges report up: onset HOLDS the station's listening window open,
        // the silence-end edge RELEASES it to a short endpoint (the window follows
        // VAD, not a fixed timeout — see PerceptionWiring.sendVad). So an inactive
        // edge reports too (vad → 2) and the face goes Silent.
        PerceptionBus.emit(PerceptionEvent.VoiceActivity(active = false, probability = 0.1f))
        advanceUntilIdle()
        assertThat(vad).isEqualTo(2)
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
