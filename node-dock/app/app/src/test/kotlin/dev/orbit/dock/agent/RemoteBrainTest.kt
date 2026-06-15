package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.station.BrainLink
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * RemoteBrain — the phone half of the server brain. Covers the protocol
 * corner cases the impl doc calls out: epoch gating of stale frames, reqId
 * dedupe, canned failure lines per code/detail, local-first stop, send-or-fail
 * turn starts, and transcript throttling.
 */
class RemoteBrainTest {

    private class FakeLink : BrainLink {
        override val connected: MutableStateFlow<Boolean> = MutableStateFlow(true)
        override var enabled: Boolean = true
        var criticalOk = true
        val frames = CopyOnWriteArrayList<Triple<String, String, JsonObject>>()

        override fun publish(topic: String, kind: String, payload: JsonObject) {
            frames.add(Triple(topic, kind, payload))
        }
        override suspend fun publishCritical(topic: String, kind: String, payload: JsonObject): Boolean {
            if (!criticalOk) return false
            frames.add(Triple(topic, kind, payload))
            return true
        }
        fun sent(kind: String) = frames.filter { it.second == kind }
    }

    private class FakeSpeaker : Speaker {
        val spoken = CopyOnWriteArrayList<String>()
        var stopped = 0
        override fun enqueueSentence(text: String) { spoken.add(text) }
        override fun stop() { stopped++ }
    }

    private class Rig {
        val link = FakeLink()
        val speaker = FakeSpeaker()
        var subtitle = ""
        val tools = DockTools(
            FaceController(dispatcher = Dispatchers.Unconfined),
            speaker,
            onSubtitle = { subtitle = it },
        )
        val brain = RemoteBrain(
            tools, link,
            scope = CoroutineScope(Dispatchers.Unconfined),
        )

        /** The turnId the brain minted for the (single) in-flight turn. */
        fun turnId(): String =
            (link.sent("turn-request").last().third["turnId"] as JsonPrimitive).content

        fun frame(kind: String, vararg pairs: Pair<String, Any>) {
            brain.onAgentFrame(kind, buildJsonObject {
                for ((k, v) in pairs) when (v) {
                    is String -> put(k, v)
                    is Boolean -> put(k, v)
                    is JsonObject -> put(k, v)
                    else -> error("unsupported $v")
                }
            })
        }
    }

    private fun await(timeoutMs: Long = 2_000, cond: () -> Boolean) = runBlocking {
        withTimeout(timeoutMs) { while (!cond()) delay(10) }
    }

    // ── turn start ─────────────────────────────────────────────────────────

    @Test
    fun `respond ships a turn-request with trigger and context`() {
        val r = Rig()
        r.brain.respond("look up and say hi")
        await { r.link.sent("turn-request").size == 1 }
        val p = r.link.sent("turn-request").single().third
        assertThat((p["trigger"] as JsonObject)["text"]!!.jsonPrimitive.content)
            .isEqualTo("look up and say hi")
        assertThat((p["context"] as JsonObject)["state"]!!.jsonPrimitive.content)
            .contains("Current face:")
        assertThat(r.brain.state.value).isInstanceOf(AgentState.Waiting::class.java)
    }

    @Test
    fun `failed critical send fails the turn locally with a spoken line`() {
        val r = Rig()
        r.link.criticalOk = false
        r.brain.respond("hello")
        await { r.speaker.spoken.isNotEmpty() }
        assertThat(r.brain.state.value).isInstanceOf(AgentState.Failed::class.java)
        assertThat(r.speaker.spoken.single()).contains("can't reach my brain")
    }

    // ── speak frames ───────────────────────────────────────────────────────

    @Test
    fun `speak frames reach TTS in order and flip state to Speaking`() {
        val r = Rig()
        r.brain.respond("hi")
        await { r.link.sent("turn-request").size == 1 }
        val id = r.turnId()
        r.frame("speak", "turnId" to id, "seq" to "0", "text" to "Hello!")
        r.frame("speak", "turnId" to id, "seq" to "1", "text" to "Nice to see you.")
        assertThat(r.speaker.spoken).containsExactly("Hello!", "Nice to see you.").inOrder()
        assertThat(r.brain.state.value).isEqualTo(AgentState.Speaking)
        // live subtitle accumulates the reply
        assertThat(r.subtitle).isEqualTo("Hello! Nice to see you.")
    }

    @Test
    fun `stale speak frames from a superseded turn are dropped`() {
        val r = Rig()
        r.brain.respond("hi")
        await { r.link.sent("turn-request").size == 1 }
        r.frame("speak", "turnId" to "some-old-turn", "seq" to "0", "text" to "ghost")
        assertThat(r.speaker.spoken).isEmpty()
    }

    // ── tool calls ─────────────────────────────────────────────────────────

    @Test
    fun `set_face tool-call dispatches and acks once even for duplicate reqIds`() {
        val r = Rig()
        r.brain.respond("smile")
        await { r.link.sent("turn-request").size == 1 }
        val id = r.turnId()
        val call = arrayOf(
            "reqId" to "rq-1", "toolCallId" to "tc-1", "turnId" to id,
            "name" to "set_face",
            "args" to buildJsonObject { put("expression", "happy") } as Any,
        )
        r.frame("tool-call", *call.map { it.first to it.second }.toTypedArray())
        r.frame("tool-call", *call.map { it.first to it.second }.toTypedArray()) // duplicate
        await { r.link.sent("tool-result").isNotEmpty() }
        val acks = r.link.sent("tool-result")
        assertThat(acks).hasSize(1)
        assertThat(acks.single().third["content"]!!.jsonPrimitive.content).isEqualTo("ok")
        assertThat(acks.single().third["isError"]!!.jsonPrimitive.content).isEqualTo("false")
    }

    @Test
    fun `unknown tool acks with isError so the turn never hangs`() {
        val r = Rig()
        r.brain.respond("do the thing")
        await { r.link.sent("turn-request").size == 1 }
        r.frame(
            "tool-call", "reqId" to "rq-2", "toolCallId" to "tc-2", "turnId" to r.turnId(),
            "name" to "launch_rocket", "args" to buildJsonObject {} as Any,
        )
        await { r.link.sent("tool-result").isNotEmpty() }
        assertThat(r.link.sent("tool-result").single().third["isError"]!!.jsonPrimitive.content)
            .isEqualTo("true")
    }

    // ── terminal turn-status ───────────────────────────────────────────────

    @Test
    fun `done with no speech settles to Idle`() {
        val r = Rig()
        r.brain.respond("nod")
        await { r.link.sent("turn-request").size == 1 }
        r.frame("turn-status", "turnId" to r.turnId(), "state" to "done")
        assertThat(r.brain.state.value).isEqualTo(AgentState.Idle)
    }

    @Test
    fun `a turn left in ToolCalling settles to Idle on done (status pill not stuck)`() {
        // the stop_task bug: a turn ended while showing ToolCalling and the pill
        // stayed stuck on the tool name (done only reset when the turn hadn't
        // spoken). Now done reconciles any transient working state to Idle.
        val r = Rig()
        r.brain.respond("stop the task")
        await { r.link.sent("turn-request").size == 1 }
        val id = r.turnId()
        r.frame("turn-status", "turnId" to id, "state" to "acting", "detail" to "stop_task")
        assertThat(r.brain.state.value).isInstanceOf(AgentState.ToolCalling::class.java)
        // turn ends while still showing the tool → must settle to Idle
        r.frame("turn-status", "turnId" to id, "state" to "done")
        assertThat(r.brain.state.value).isEqualTo(AgentState.Idle)
    }

    @Test
    fun `failed timeout speaks the canned timeout line`() {
        val r = Rig()
        r.brain.respond("hmm")
        await { r.link.sent("turn-request").size == 1 }
        r.frame("turn-status", "turnId" to r.turnId(), "state" to "failed", "code" to "timeout")
        assertThat(r.brain.state.value).isInstanceOf(AgentState.Failed::class.java)
        assertThat(r.speaker.spoken.single()).contains("took too long")
    }

    @Test
    fun `failed lost-train-of-thought softens the line`() {
        val r = Rig()
        r.brain.respond("hmm")
        await { r.link.sent("turn-request").size == 1 }
        r.frame(
            "turn-status", "turnId" to r.turnId(), "state" to "failed",
            "code" to "llm_error", "detail" to "lost-train-of-thought",
        )
        assertThat(r.speaker.spoken.single()).contains("lost my train of thought")
    }

    // ── stop / cancel ──────────────────────────────────────────────────────

    @Test
    fun `stop silences locally first and publishes turn-cancel`() {
        val r = Rig()
        r.brain.respond("long story please")
        await { r.link.sent("turn-request").size == 1 }
        val id = r.turnId()
        r.brain.stop()
        assertThat(r.speaker.stopped).isAtLeast(1)
        assertThat(r.brain.state.value).isEqualTo(AgentState.Idle)
        await { r.link.sent("turn-cancel").size == 1 }
        assertThat(r.link.sent("turn-cancel").single().third["turnId"]!!.jsonPrimitive.content)
            .isEqualTo(id)
        // post-stop stragglers are dropped (epoch cleared)
        r.frame("speak", "turnId" to id, "seq" to "5", "text" to "too late")
        assertThat(r.speaker.spoken).isEmpty()
    }

    @Test
    fun `link drop mid-turn fails the turn audibly`() {
        val r = Rig()
        r.brain.respond("hi")
        await { r.link.sent("turn-request").size == 1 }
        r.link.connected.value = false
        await { r.speaker.spoken.isNotEmpty() }
        assertThat(r.brain.state.value).isInstanceOf(AgentState.Failed::class.java)
        assertThat(r.speaker.spoken.single()).contains("lost the link")
    }

    // ── autonomous (task) turn adoption (docs/TASKS_V1.md §7b) ───────────────

    @Test
    fun `autonomous accepted turn is adopted so its speak frames reach TTS`() {
        val r = Rig()
        // no local turn in flight; the station injects a task turn
        r.frame("turn-status", "turnId" to "auto-1", "state" to "accepted", "autonomous" to true)
        assertThat(r.brain.state.value).isInstanceOf(AgentState.Waiting::class.java)
        // its speak frames now pass the turnId gate (previously dropped as stale)
        r.frame("speak", "turnId" to "auto-1", "seq" to "0", "text" to "You picked up your phone.")
        assertThat(r.speaker.spoken).containsExactly("You picked up your phone.")
        // terminal done settles locally
        r.frame("turn-status", "turnId" to "auto-1", "state" to "done")
    }

    @Test
    fun `autonomous accepted is ignored while a local user turn is active`() {
        val r = Rig()
        r.brain.respond("hi")
        await { r.link.sent("turn-request").size == 1 }
        val localId = r.turnId()
        // a task turn arrives mid-user-turn → ignored (station's supersede sorts it out)
        r.frame("turn-status", "turnId" to "auto-2", "state" to "accepted", "autonomous" to true)
        // the local turn is still the current one — a task speak does NOT play
        r.frame("speak", "turnId" to "auto-2", "seq" to "0", "text" to "ghost task")
        assertThat(r.speaker.spoken).isEmpty()
        // the local turn's own speak still works
        r.frame("speak", "turnId" to localId, "seq" to "0", "text" to "user reply")
        assertThat(r.speaker.spoken).containsExactly("user reply")
    }

    @Test
    fun `a new autonomous turn is adopted even when a prior turn left turnActive stale`() {
        val r = Rig()
        // a first autonomous turn arrives but NEVER gets its terminal `done` (e.g.
        // the model hung) — turnActive stays true, currentTurnId stuck on auto-A.
        r.frame("turn-status", "turnId" to "auto-A", "state" to "accepted", "autonomous" to true)
        r.frame("speak", "turnId" to "auto-A", "seq" to "0", "text" to "first reminder")
        assertThat(r.speaker.spoken).containsExactly("first reminder")
        // (no `done` for auto-A — turnActive remains true)

        // a SECOND reminder fires. Previously this was refused (`if (turnActive) return`)
        // and its speak dropped as stale. Now it must adopt + speak.
        r.frame("turn-status", "turnId" to "auto-B", "state" to "accepted", "autonomous" to true)
        r.frame("speak", "turnId" to "auto-B", "seq" to "0", "text" to "second reminder")
        assertThat(r.speaker.spoken).containsExactly("first reminder", "second reminder")
    }

    @Test
    fun `a non-autonomous accepted for an unknown turn is still dropped`() {
        val r = Rig()
        // accepted WITHOUT autonomous:true for a turn we didn't start → ignored
        r.frame("turn-status", "turnId" to "stranger", "state" to "accepted")
        r.frame("speak", "turnId" to "stranger", "seq" to "0", "text" to "nope")
        assertThat(r.speaker.spoken).isEmpty()
        assertThat(r.brain.state.value).isEqualTo(AgentState.Idle)
    }

    // ── transcripts ────────────────────────────────────────────────────────

    @Test
    fun `transcript partials are throttled but finals always ship`() {
        val r = Rig()
        r.brain.noteTranscript("loo", isFinal = false)
        r.brain.noteTranscript("look u", isFinal = false) // < 100ms later → dropped
        r.brain.noteTranscript("look up", isFinal = true)
        val sent = r.link.sent("transcript")
        assertThat(sent).hasSize(2)
        assertThat(sent.last().third["isFinal"]!!.jsonPrimitive.content).isEqualTo("true")
        // same utterance id across the partial + final
        assertThat(sent.map { it.third["utteranceId"]!!.jsonPrimitive.content }.toSet()).hasSize(1)
    }

    @Test
    fun `unconfigured brain speaks the setup hint instead of ghosting`() {
        val r = Rig()
        r.link.enabled = false
        r.brain.respond("hello?")
        assertThat(r.speaker.spoken.single()).contains("STATION_URL")
        assertThat(r.link.sent("turn-request")).isEmpty()
    }

    // ── failure diagnosis: the dock says what actually went wrong ────────────

    @Test
    fun `daily quota error is diagnosed specifically`() {
        // the real Gemini free-tier 429 body
        val err = """{"error":{"code":429,"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}"""
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", err)
        assertThat(d.label).contains("quota")
        assertThat(d.spoken.lowercase()).contains("daily")
    }

    @Test
    fun `per-minute rate limit differs from daily quota`() {
        val err = """{"error":{"code":429,"message":"Resource exhausted, please retry","status":"RESOURCE_EXHAUSTED"}}"""
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", err)
        assertThat(d.label).contains("rate")
        assertThat(d.spoken.lowercase()).contains("few seconds")
    }

    @Test
    fun `out of credits (402) is diagnosed`() {
        val err = "402 This request requires more credits, or fewer max_tokens."
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", err)
        assertThat(d.label).contains("credits")
        assertThat(d.spoken.lowercase()).contains("credits")
    }

    @Test
    fun `bad api key (401) is diagnosed`() {
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", "401 Unauthorized: invalid API key")
        assertThat(d.label).contains("key")
        assertThat(d.spoken.lowercase()).contains("key")
    }

    @Test
    fun `unknown model (404) is diagnosed`() {
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", "404 model not found: gemini-9-ultra")
        assertThat(d.label).contains("model")
        assertThat(d.spoken.lowercase()).contains("model name")
    }

    @Test
    fun `provider overload (503) is diagnosed as temporary`() {
        val err = """{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}"""
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", err)
        assertThat(d.label).contains("overloaded")
        assertThat(d.spoken.lowercase()).contains("temporary")
    }

    @Test
    fun `timeout keeps its friendly line`() {
        val d = diagnoseTurnFailure("timeout", "", "")
        assertThat(d.spoken.lowercase()).contains("too long")
    }

    @Test
    fun `unknown provider error surfaces a trimmed gist instead of a blank line`() {
        val err = """{"error":{"message":"the flux capacitor desynchronized unexpectedly"}}"""
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", err)
        assertThat(d.spoken).contains("flux capacitor desynchronized")
    }

    @Test
    fun `blank error degrades gracefully`() {
        val d = diagnoseTurnFailure("llm_error", "model-unreachable", "")
        assertThat(d.spoken).isNotEmpty()
        assertThat(d.label).isNotEmpty()
    }
}
