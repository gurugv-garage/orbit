package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.body.BodyController
import dev.orbit.dock.body.BodyStateCatalog
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The body-movement sequencer — the dock's whole "physical" half — exercised
 * against a MOCK body (no WebSocket, no servos). This is the part that was
 * previously only "verified on-device"; it covers exactly the complicated
 * behaviour: validation feedback, timed multi-step sequences, `wait:` pauses,
 * per-move travel-time gaps, and preemption of a running gesture.
 *
 * Timing note: [DockTools] runs sequences on a real `Dispatchers.Default`
 * scope, so these tests assert on observed order + recorded wall-clock gaps
 * (poll-and-wait), not on a virtual test clock.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MakeBodyMovementsTest {

    private class FakeSpeaker : Speaker {
        override fun enqueueSentence(text: String) {}
        override fun stop() {}
    }

    /** A mock body that records every setState with the time it arrived. */
    private class FakeBody(
        connected: Boolean,
        catalog: BodyStateCatalog,
    ) : BodyController {
        data class Move(val part: String, val state: String, val atMs: Long)

        private val _connected = MutableStateFlow(connected)
        override val connected: StateFlow<Boolean> = _connected
        override val validatedCatalog: BodyStateCatalog = catalog

        val moves = CopyOnWriteArrayList<Move>()
        private val t0 = System.currentTimeMillis()

        override suspend fun setState(part: String, stateName: String) {
            moves.add(Move(part, stateName, System.currentTimeMillis() - t0))
        }

        override suspend fun setAngle(part: String, pulseWidthUs: Int, durationMs: Int, label: String) {
            moves.add(Move(part, "${pulseWidthUs}us", System.currentTimeMillis() - t0))
        }

        fun parts(): List<String> = moves.map { it.part }
        fun states(): List<Pair<String, String>> = moves.map { it.part to it.state }
    }

    /** A catalog mirroring states.json: neck {lookUp,lookDown,center}, foot
     *  {forward,left,right}, with per-state travel durations. */
    private fun catalog(
        neckMs: Int = 300,
        footMs: Int = 200,
    ): BodyStateCatalog {
        fun cmd(ms: Int) = BodyStateCatalog.PrimitiveCommand(params = mapOf("pulse_width_us" to 1500.0), durationMs = ms)
        return BodyStateCatalog(
            mapOf(
                "neck" to BodyStateCatalog.PartCatalog(
                    home = "center",
                    states = mapOf("lookUp" to cmd(neckMs), "lookDown" to cmd(neckMs), "center" to cmd(neckMs)),
                ),
                "foot" to BodyStateCatalog.PartCatalog(
                    home = "forward",
                    states = mapOf("forward" to cmd(footMs), "left" to cmd(footMs), "right" to cmd(footMs)),
                ),
            ),
        )
    }

    private lateinit var tools: DockTools
    private lateinit var body: FakeBody

    @Before fun setUp() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun tearDown() = Dispatchers.resetMain()

    private fun toolsWith(body: FakeBody): DockTools {
        this.body = body
        return DockTools(face = FaceController(), tts = FakeSpeaker(), onSubtitle = {}, body = body)
    }

    private fun waitUntil(timeoutMs: Long = 5_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(10)
        }
        throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    // ── connected happy path ─────────────────────────────────────────────

    @Test
    fun singleMoveResolvesAndSendsToBody() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        val r = t.makeBodyMovements("foot:left")
        assertThat(r).isEqualTo("ok — running 1 moves")
        waitUntil { body.moves.size == 1 }
        assertThat(body.states()).containsExactly("foot" to "left")
    }

    @Test
    fun multiStepSequenceRunsAllMovesInOrder() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        // A "wiggle": left, right, left, right, forward.
        val r = t.makeBodyMovements("foot:left; foot:right; foot:left; foot:right; foot:forward")
        assertThat(r).isEqualTo("ok — running 5 moves")
        waitUntil { body.moves.size == 5 }
        assertThat(body.states()).containsExactly(
            "foot" to "left", "foot" to "right", "foot" to "left",
            "foot" to "right", "foot" to "forward",
        ).inOrder()
    }

    @Test
    fun mixedPartsNodThenLook() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        t.makeBodyMovements("neck:lookDown; neck:center; foot:left")
        waitUntil { body.moves.size == 3 }
        assertThat(body.states()).containsExactly(
            "neck" to "lookDown", "neck" to "center", "foot" to "left",
        ).inOrder()
    }

    // ── timing: travel-time gaps + explicit waits ────────────────────────

    @Test
    fun eachMoveWaitsItsTravelTimeBeforeTheNext() {
        // neck travel = 300ms; two neck moves should be ~300ms apart (+40ms slack).
        val t = toolsWith(FakeBody(connected = true, catalog = catalog(neckMs = 300)))
        t.makeBodyMovements("neck:lookUp; neck:center")
        waitUntil { body.moves.size == 2 }
        val gap = body.moves[1].atMs - body.moves[0].atMs
        // Gap is travelMs(300) + 40ms slack; allow generous bounds for CI jitter.
        assertThat(gap).isAtLeast(300L)
        assertThat(gap).isLessThan(900L)
    }

    @Test
    fun explicitWaitStepInsertsAPause() {
        // foot travel = 100ms; a wait:1000 between two moves dominates the gap.
        val t = toolsWith(FakeBody(connected = true, catalog = catalog(footMs = 100)))
        val r = t.makeBodyMovements("foot:left; wait:1000; foot:right")
        // wait is not a "move", so the move count is 2.
        assertThat(r).isEqualTo("ok — running 2 moves")
        waitUntil { body.moves.size == 2 }
        val gap = body.moves[1].atMs - body.moves[0].atMs
        // ~100ms travel + 40ms slack + 1000ms wait.
        assertThat(gap).isAtLeast(1000L)
    }

    @Test
    fun waitIsClampedToFiveSeconds() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog(footMs = 50)))
        // 99s wait must clamp to 5s — assert the second move arrives well before 99s.
        t.makeBodyMovements("foot:left; wait:99000; foot:right")
        waitUntil(timeoutMs = 8_000) { body.moves.size == 2 }
        val gap = body.moves[1].atMs - body.moves[0].atMs
        assertThat(gap).isLessThan(7_000L) // clamped to 5s + slack, not 99s
    }

    // ── validation feedback (synchronous return string) ──────────────────

    @Test
    fun unknownStateIsReportedButValidMovesStillRun() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        val r = t.makeBodyMovements("foot:left; neck:spin; foot:right")
        // The bogus neck:spin is flagged; the two valid foot moves still run.
        assertThat(r).contains("running 2 moves")
        assertThat(r).contains("unknown neck state 'spin'")
        waitUntil { body.moves.size == 2 }
        assertThat(body.states()).containsExactly("foot" to "left", "foot" to "right").inOrder()
    }

    @Test
    fun unknownPartIsReported() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        val r = t.makeBodyMovements("arm:wave")
        assertThat(r).contains("unknown part 'arm'")
        // No valid moves → nothing sent.
        Thread.sleep(100)
        assertThat(body.moves).isEmpty()
    }

    @Test
    fun malformedStepIsReported() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        val r = t.makeBodyMovements("just-garbage; foot:left")
        assertThat(r).contains("bad step 'just-garbage'")
        assertThat(r).contains("running 1 moves")
        waitUntil { body.moves.size == 1 }
        assertThat(body.states()).containsExactly("foot" to "left")
    }

    @Test
    fun negativeWaitIsReported() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        val r = t.makeBodyMovements("wait:-5; foot:left")
        assertThat(r).contains("bad wait 'wait:-5'")
        assertThat(r).contains("running 1 moves")
    }

    @Test
    fun emptySequenceReported() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog()))
        assertThat(t.makeBodyMovements("   ")).isEqualTo("empty sequence")
        assertThat(t.makeBodyMovements(";;;")).isEqualTo("empty sequence")
    }

    // ── preemption ───────────────────────────────────────────────────────

    @Test
    fun newSequencePreemptsTheRunningOne() {
        // A long neck sequence (300ms travel each) is interrupted after the
        // first move by a new command; the rest of the first must NOT run.
        val t = toolsWith(FakeBody(connected = true, catalog = catalog(neckMs = 300, footMs = 50)))
        t.makeBodyMovements("neck:lookUp; neck:lookDown; neck:center")
        waitUntil { body.moves.size == 1 } // first move out
        // Interrupt mid-travel with a short new sequence.
        t.makeBodyMovements("foot:right")
        waitUntil { body.states().contains("foot" to "right") }
        Thread.sleep(700) // let any stale moves from the first seq try to fire
        // The first sequence's later neck moves were cancelled.
        val neckMoves = body.moves.count { it.part == "neck" }
        assertThat(neckMoves).isEqualTo(1)
        assertThat(body.states()).contains("foot" to "right")
    }

    @Test
    fun stopBodyCancelsARunningSequence() {
        val t = toolsWith(FakeBody(connected = true, catalog = catalog(neckMs = 300)))
        t.makeBodyMovements("neck:lookUp; neck:lookDown; neck:center")
        waitUntil { body.moves.size == 1 }
        t.stopBody()
        Thread.sleep(800)
        // Cancelled after the first move; later ones never fired.
        assertThat(body.moves.size).isEqualTo(1)
    }

    // ── disconnected / null body ─────────────────────────────────────────

    @Test
    fun disconnectedBodyDoesNotSendButReports() {
        val t = toolsWith(FakeBody(connected = false, catalog = catalog()))
        val r = t.makeBodyMovements("foot:left")
        assertThat(r).contains("no body connected")
        Thread.sleep(100)
        assertThat(body.moves).isEmpty()
    }

    @Test
    fun nullBodyReportsNotConnected() {
        val t = DockTools(face = FaceController(), tts = FakeSpeaker(), onSubtitle = {}, body = null)
        assertThat(t.makeBodyMovements("foot:left")).contains("no body connected")
    }
}
