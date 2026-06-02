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
 * calls — move_body part/state pairing, named gestures, model-authored
 * move_sequence, and the human status phrasing. Drives them against a mock body
 * (no socket/servos) so the validation + sequence-building logic is testable.
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
        override suspend fun setState(part: String, stateName: String) { moves.add(part to stateName) }
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

    private fun waitMoves(n: Int) {
        val end = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < end) { if (body.moves.size >= n) return; Thread.sleep(10) }
    }

    // ── move_body ─────────────────────────────────────────────────────────

    @Test fun moveBodyValidPairExecutes() = runTest {
        val r = tool("move_body").execute("1", args("""{"part":"neck","state":"lookDown"}"""), null)
        assertThat(text(r)).contains("running 1 moves")
        waitMoves(1); assertThat(body.moves).containsExactly("neck" to "lookDown")
    }

    @Test fun moveBodyRejectsMismatchedPair() = runTest {
        // neck has no 'left' (that's a foot state) — rejected before the body call.
        val r = tool("move_body").execute("1", args("""{"part":"neck","state":"left"}"""), null)
        assertThat(text(r)).contains("neck has no 'left'")
        Thread.sleep(80); assertThat(body.moves).isEmpty()
    }

    // ── gesture ─────────────────────────────────────────────────────────────

    @Test fun gestureNodExpandsToNeckSequence() = runTest {
        val r = tool("gesture").execute("1", args("""{"name":"nod"}"""), null)
        assertThat(text(r)).contains("running")
        waitMoves(2)
        assertThat(body.moves.map { it.first }.distinct()).containsExactly("neck")
        assertThat(body.moves.size).isAtLeast(2)
    }

    @Test fun gestureUnknownReported() = runTest {
        val r = tool("gesture").execute("1", args("""{"name":"backflip"}"""), null)
        assertThat(text(r)).contains("unknown gesture")
    }

    // ── move_sequence (model-authored) ──────────────────────────────────────

    @Test fun moveSequenceRunsAuthoredSteps() = runTest {
        val r = tool("move_sequence").execute(
            "1",
            args("""{"steps":[{"part":"neck","state":"lookUp","wait_ms":100},{"part":"neck","state":"center"}]}"""),
            null,
        )
        assertThat(text(r)).contains("running 2 moves")
        waitMoves(2)
        assertThat(body.moves).containsExactly("neck" to "lookUp", "neck" to "center").inOrder()
    }

    @Test fun moveSequenceSkipsInvalidStepsButRunsValidOnes() = runTest {
        val r = tool("move_sequence").execute(
            "1",
            args("""{"steps":[{"part":"neck","state":"lookUp"},{"part":"neck","state":"sideways"},{"part":"foot","state":"left"}]}"""),
            null,
        )
        assertThat(text(r)).contains("skipped")
        waitMoves(2)
        assertThat(body.moves).containsExactly("neck" to "lookUp", "foot" to "left").inOrder()
    }

    @Test fun moveSequenceAllInvalidReportsNothingRun() = runTest {
        val r = tool("move_sequence").execute("1", args("""{"steps":[{"part":"arm","state":"wave"}]}"""), null)
        assertThat(text(r)).contains("no valid steps")
        Thread.sleep(80); assertThat(body.moves).isEmpty()
    }

    // ── status phrasing (live per-action label) ─────────────────────────────

    @Test fun statusPhraseMapsToHumanLabels() {
        assertThat(DockToolsAdapter.statusPhrase("move_body", args("""{"part":"foot","state":"left"}"""))).isEqualTo("turning left")
        assertThat(DockToolsAdapter.statusPhrase("move_body", args("""{"part":"neck","state":"lookUp"}"""))).isEqualTo("looking up")
        assertThat(DockToolsAdapter.statusPhrase("set_face", args("""{"expression":"happy"}"""))).isEqualTo("smiling")
        assertThat(DockToolsAdapter.statusPhrase("gesture", args("""{"name":"nod"}"""))).isEqualTo("nodding")
    }
}
