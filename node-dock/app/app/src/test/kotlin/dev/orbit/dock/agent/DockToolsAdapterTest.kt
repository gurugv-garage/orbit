package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.body.BodyController
import dev.orbit.dock.body.BodyStateCatalog
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import dev.pi.agent.AgentTool
import dev.pi.ai.TextContent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The agent's tool surface: validates the [DockToolsAdapter] tools the model
 * calls — the single degrees-based `move` tool (one or many steps, °→µs
 * conversion, sequencing) and the human status phrasing. Drives them against a
 * mock body (no socket/servos) so the conversion + sequence-building is testable.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DockToolsAdapterTest {

    private class FakeSpeaker : Speaker {
        override fun enqueueSentence(text: String) {}
        override fun stop() {}
    }

    private class FakeBody(catalog: BodyStateCatalog) : BodyController {
        private val _c = MutableStateFlow(true)
        override val connected: StateFlow<Boolean> = _c
        override val validatedCatalog: BodyStateCatalog = catalog
        val moves = CopyOnWriteArrayList<Pair<String, String>>()
        val angles = CopyOnWriteArrayList<Triple<String, Int, Int>>()
        override suspend fun setState(part: String, stateName: String) { moves.add(part to stateName) }
        override suspend fun setAngle(part: String, pulseWidthUs: Int, durationMs: Int, label: String) { angles.add(Triple(part, pulseWidthUs, durationMs)) }
        val batches = CopyOnWriteArrayList<Map<String, Int>>()  // each simultaneous setAngles call
        override suspend fun setAngles(targets: Map<String, Pair<Int, String>>, durationMs: Int) {
            batches.add(targets.mapValues { it.value.first })
            targets.forEach { (p, v) -> angles.add(Triple(p, v.first, durationMs)) }
        }
    }

    private fun catalog(): BodyStateCatalog {
        fun cmd() = BodyStateCatalog.PrimitiveCommand(mapOf("pulse_width_us" to 1500.0), durationMs = 50)
        return BodyStateCatalog(
            mapOf(
                "neck" to BodyStateCatalog.PartCatalog("center", mapOf("lookUp" to cmd(), "lookDown" to cmd(), "center" to cmd())),
                "foot" to BodyStateCatalog.PartCatalog("forward", mapOf("forward" to cmd(), "left" to cmd(), "right" to cmd())),
            ),
        )
    }

    private val json = Json { isLenient = true }
    private fun args(s: String): JsonObject = json.parseToJsonElement(s).jsonObject
    private fun text(r: dev.pi.agent.AgentToolResult<Any?>) = (r.content.first() as TextContent).text

    private lateinit var body: FakeBody
    private lateinit var tools: DockTools
    private fun tool(name: String): AgentTool = DockToolsAdapter.tools(tools).first { it.name == name }

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        body = FakeBody(catalog())
        tools = DockTools(face = FaceController(), tts = FakeSpeaker(), onSubtitle = {}, body = body)
    }
    @After fun tearDown() = Dispatchers.resetMain()

    private fun waitAngles(n: Int) {
        val end = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < end) { if (body.angles.size >= n) return; Thread.sleep(10) }
    }

    // ── move: single step ───────────────────────────────────────────────────

    @Test fun degreesUseFixedScale() = runTest {
        // Fixed universal scale: +90° = 2500µs. foot allows ±90, so +90 → ~2500.
        val r = tool("move").execute("1", args("""{"steps":[{"part":"foot","degrees":90,"duration_ms":300}]}"""), null)
        assertThat(text(r)).contains("running 1 step")
        waitAngles(1)
        val (part, us, dur) = body.angles.first()
        assertThat(part).isEqualTo("foot")
        assertThat(us).isAtLeast(2480)   // +90° on the fixed scale
        assertThat(dur).isEqualTo(300)
    }

    @Test fun perPartLimitClampsBeyondRange() = runTest {
        // neck limit is -60°…+35° (asymmetric, per DockToolSchemas.DEGREE_LIMITS).
        // Scale is FIXED (90°=1000µs), so +35° = 1500 + (35/90)*1000 ≈ 1889µs.
        // Commanding +90° must CLAMP to the +35° max, NOT go to the full 2500.
        tool("move").execute("1", args("""{"steps":[{"part":"neck","degrees":90}]}"""), null)
        waitAngles(1)
        val us = body.angles.first().second
        assertThat(us).isAtLeast(1849)   // +35° ≈ 1889µs (allow ±40 slop)
        assertThat(us).isAtMost(1929)
    }

    @Test fun centerDegreesMapsToMidpoint() = runTest {
        tool("move").execute("1", args("""{"steps":[{"part":"foot","degrees":0}]}"""), null)
        waitAngles(1)
        assertThat(body.angles.first().second).isEqualTo(1500)   // 0° = center
    }

    @Test fun negativeDegreesGoBelowCenter() = runTest {
        // foot -90 = full left → ~500µs.
        tool("move").execute("1", args("""{"steps":[{"part":"foot","degrees":-90}]}"""), null)
        waitAngles(1)
        assertThat(body.angles.first().second).isAtMost(600)
    }

    // ── move: SIMULTANEOUS (one step, many joints) ──────────────────────────

    @Test fun multiJointStepMovesPartsTogetherInOneBatch() = runTest {
        // neck AND foot in ONE step → a single setAngles batch (move together).
        val r = tool("move").execute(
            "1",
            args("""{"steps":[{"parts":[{"part":"neck","degrees":-20},{"part":"foot","degrees":45}],"duration_ms":300}]}"""),
            null,
        )
        assertThat(text(r)).contains("running 1 step")
        waitAngles(2)
        // exactly ONE batch carrying both parts (proves simultaneity).
        assertThat(body.batches).hasSize(1)
        assertThat(body.batches.first().keys).containsExactly("neck", "foot")
        assertThat(body.batches.first()["neck"]!!).isLessThan(1500)   // -20° = up
        assertThat(body.batches.first()["foot"]!!).isGreaterThan(1500) // +45° = right
    }

    @Test fun singleJointStepStillWorks() = runTest {
        // back-compat: the old {part,degrees} form is a one-joint batch.
        tool("move").execute("1", args("""{"steps":[{"part":"neck","degrees":-20}]}"""), null)
        waitAngles(1)
        assertThat(body.batches).hasSize(1)
        assertThat(body.batches.first().keys).containsExactly("neck")
    }

    // ── move: sequencing ────────────────────────────────────────────────────

    @Test fun multiStepRunsAllStepsInOrder() = runTest {
        val r = tool("move").execute(
            "1",
            args("""{"steps":[{"part":"neck","degrees":20,"duration_ms":50,"wait_ms":50},{"part":"neck","degrees":0,"duration_ms":50}]}"""),
            null,
        )
        assertThat(text(r)).contains("running 2 step")
        waitAngles(2)
        assertThat(body.angles.map { it.first }).containsExactly("neck", "neck").inOrder()
        // first step (down, +deg) should be a higher µs than the second (center).
        assertThat(body.angles[0].second).isGreaterThan(body.angles[1].second)
    }

    @Test fun waitOnlyStepIsAValidPause() = runTest {
        // The model emits {wait_ms:N} as its own step between moves — must NOT be
        // rejected. Two moves around a pause = 2 angle batches, run in order.
        val r = tool("move").execute(
            "1",
            args("""{"steps":[{"part":"foot","degrees":-90,"duration_ms":50},{"wait_ms":100},{"part":"foot","degrees":90,"duration_ms":50}]}"""),
            null,
        )
        assertThat(text(r)).doesNotContain("no part")   // the wait step isn't an error
        waitAngles(2)
        assertThat(body.angles.map { it.first }).containsExactly("foot", "foot").inOrder()
        assertThat(body.angles[0].second).isLessThan(body.angles[1].second) // -90 then +90
    }

    @Test fun unknownPartSkippedValidStepsRun() = runTest {
        val r = tool("move").execute(
            "1",
            args("""{"steps":[{"part":"arm","degrees":10},{"part":"foot","degrees":45}]}"""),
            null,
        )
        assertThat(text(r)).contains("issues")
        waitAngles(1)
        assertThat(body.angles.map { it.first }).containsExactly("foot")
    }

    @Test fun allInvalidReportsNothingRun() = runTest {
        val r = tool("move").execute("1", args("""{"steps":[{"part":"arm","degrees":10}]}"""), null)
        assertThat(text(r)).contains("no valid steps")
        Thread.sleep(80); assertThat(body.angles).isEmpty()
    }

    // ── status phrasing (live per-action label) ─────────────────────────────

    @Test fun statusPhraseMapsToHumanLabels() {
        assertThat(DockToolsAdapter.statusPhrase("move", args("""{"steps":[{"part":"foot","degrees":-40}]}"""))).isEqualTo("turning left")
        assertThat(DockToolsAdapter.statusPhrase("move", args("""{"steps":[{"part":"neck","degrees":-20}]}"""))).isEqualTo("looking up")
        assertThat(DockToolsAdapter.statusPhrase("move", args("""{"steps":[{"part":"neck","degrees":20}]}"""))).isEqualTo("looking down")
        assertThat(DockToolsAdapter.statusPhrase("set_face", args("""{"expression":"happy"}"""))).isEqualTo("smiling")
        // multi-step → generic "moving"
        assertThat(DockToolsAdapter.statusPhrase("move", args("""{"steps":[{"part":"neck","degrees":-20},{"part":"neck","degrees":0}]}"""))).isEqualTo("moving")
    }
}
