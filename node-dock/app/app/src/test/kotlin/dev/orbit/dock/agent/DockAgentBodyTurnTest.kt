package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.body.BodyController
import dev.orbit.dock.body.BodyStateCatalog
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.AssistantMessageEventStream
import dev.pi.ai.StopReason
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.Usage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Facade → tool-call → real body path, end-to-end through [DockAgent] but with a
 * SCRIPTED StreamFn instead of a live model (the `streamFnOverride` seam). Proves
 * that when the loop produces a `move_body` tool call, the dock actually drives
 * the connected body — the integration the on-device runs show, now in a fast,
 * deterministic unit test (the user asked for a body-movement test case).
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DockAgentBodyTurnTest {

    private class FakeSpeaker : Speaker {
        val spoken = CopyOnWriteArrayList<String>()
        override fun enqueueSentence(text: String) { spoken.add(text) }
        override fun stop() {}
    }

    private class FakeBody : BodyController {
        override val connected: StateFlow<Boolean> = MutableStateFlow(true)
        override val validatedCatalog: BodyStateCatalog = BodyStateCatalog(
            mapOf(
                "neck" to BodyStateCatalog.PartCatalog(
                    "center",
                    mapOf(
                        "lookUp" to cmd(), "lookDown" to cmd(), "center" to cmd(),
                    ),
                ),
            ),
        )
        val moves = CopyOnWriteArrayList<Pair<String, String>>()
        val angles = CopyOnWriteArrayList<Triple<String, Int, Int>>()
        override suspend fun setState(part: String, stateName: String) { moves.add(part to stateName) }
        override suspend fun setAngle(part: String, pulseWidthUs: Int, durationMs: Int, label: String) { angles.add(Triple(part, pulseWidthUs, durationMs)) }
        override suspend fun setAngles(targets: Map<String, Pair<Int, String>>, durationMs: Int) {
            targets.forEach { (p, v) -> angles.add(Triple(p, v.first, durationMs)) }
        }
        private companion object {
            fun cmd() = BodyStateCatalog.PrimitiveCommand(mapOf("pulse_width_us" to 1500.0), durationMs = 20)
        }
    }

    private lateinit var body: FakeBody
    private lateinit var tts: FakeSpeaker

    @Before fun setUp() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun tearDown() = Dispatchers.resetMain()

    /**
     * Round 1: a `move_body` tool call. Round 2 (after the tool result is fed
     * back): a plain spoken line, ending the loop. Stateful so the loop
     * terminates (returning the tool script forever would loop infinitely).
     */
    private fun scriptedMoveThenSpeak(scope: kotlinx.coroutines.CoroutineScope): StreamFn {
        var round = 0
        return { m, _, _ ->
            val out = AssistantMessageEventStream()
            val msg = if (round++ == 0) {
                val call = ToolCall(
                    id = "c1", name = "move",
                    arguments = buildJsonObject {
                        putJsonArray("steps") {
                            add(buildJsonObject { put("part", "neck"); put("degrees", 20); put("duration_ms", 50) })
                        }
                    },
                )
                AssistantMessage(
                    content = listOf(TextContent("Looking down."), call),
                    api = m.api, provider = m.provider, model = m.id,
                    usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
                )
            } else {
                AssistantMessage(
                    content = listOf(TextContent("Done.")),
                    api = m.api, provider = m.provider, model = m.id,
                    usage = Usage.EMPTY, stopReason = StopReason.STOP,
                )
            }
            scope.launch {
                out.push(AssistantMessageEvent.Start(msg))
                out.push(AssistantMessageEvent.Done(msg.stopReason, msg))
            }
            out
        }
    }

    private fun waitUntil(ms: Long = 4000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) { if (cond()) return; Thread.sleep(10) }
        throw AssertionError("condition not met in ${ms}ms")
    }

    @Test
    fun toolCallFromTheLoopDrivesTheRealBody() {
        body = FakeBody()
        tts = FakeSpeaker()
        // A real scope for the faux stream (NOT a runTest virtual-time scope —
        // the agent runs on Dispatchers.IO + the body on Default; we wait on
        // real wall-clock, like MakeBodyMovementsTest).
        val faux = kotlinx.coroutines.CoroutineScope(Dispatchers.Default)
        val tools = DockTools(FaceController(kotlinx.coroutines.Dispatchers.Unconfined), tts, onSubtitle = {}, body = body)
        val agent = DockAgent(
            tools = tools,
            baseUrl = "http://unused", model = "faux",
            streamFnOverride = scriptedMoveThenSpeak(faux),
        )

        agent.respond("look down")

        // The scripted `move` tool call must reach the body's setAngle (°→µs).
        waitUntil { body.angles.isNotEmpty() }
        assertThat(body.angles.first().first).isEqualTo("neck")
        assertThat(body.angles.first().second).isGreaterThan(1500)   // +20° → below center (down)
        agent.shutdown()
        faux.cancel()
    }
}
