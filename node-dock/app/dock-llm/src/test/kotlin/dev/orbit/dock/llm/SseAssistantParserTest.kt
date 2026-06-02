package dev.orbit.dock.llm

import com.google.common.truth.Truth.assertThat
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.Model
import dev.pi.ai.StopReason
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test

/**
 * OpenAI `/v1/chat/completions` SSE parser (llama.cpp / OpenRouter). Tool calls
 * stream as FRAGMENTS across chunks (id/name on the opener, arguments in pieces)
 * and must reassemble by index — mirrors the real Qwen3.6 wire shape. Fed `data:`
 * payloads directly (no socket).
 */
class SseAssistantParserTest {

    private val model = Model("qwen", "qwen", "openai-completions", "llama.cpp")
    private fun run(vararg payloads: String): List<AssistantMessageEvent> {
        val p = SseAssistantParser(model)
        return payloads.flatMap { p.accept(it) }
    }

    @Test
    fun textStreamsAsDeltasThenDone() {
        val events = run(
            """{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}""",
            """{"choices":[{"delta":{"content":"lo"}}]}""",
            """{"choices":[{"delta":{},"finish_reason":"stop"}]}""",
            "[DONE]",
        )
        assertThat(events.first()).isInstanceOf(AssistantMessageEvent.Start::class.java)
        assertThat(events.filterIsInstance<AssistantMessageEvent.TextDelta>().map { it.delta })
            .containsExactly("Hel", "lo").inOrder()
        val done = events.last() as AssistantMessageEvent.Done
        assertThat((done.message.content.first() as TextContent).text).isEqualTo("Hello")
        assertThat(done.message.stopReason).isEqualTo(StopReason.STOP)
    }

    @Test
    fun toolCallArgsReassembleFromFragments() {
        val events = run(
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"move_body","arguments":""}}]}}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"part\":\"neck\","}}]}}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"state\":\"lookDown\"}"}}]}}]}""",
            """{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}""",
            "[DONE]",
        )
        val done = events.last() as AssistantMessageEvent.Done
        assertThat(done.message.stopReason).isEqualTo(StopReason.TOOL_USE)
        val call = done.message.content.filterIsInstance<ToolCall>().single()
        assertThat(call.name).isEqualTo("move_body")
        assertThat(call.arguments["part"]?.jsonPrimitive?.content).isEqualTo("neck")
        assertThat(call.arguments["state"]?.jsonPrimitive?.content).isEqualTo("lookDown")
        // The reassembled call is surfaced as a ToolCallEnd before Done.
        assertThat(events.filterIsInstance<AssistantMessageEvent.ToolCallEnd>()).hasSize(1)
    }

    @Test
    fun twoParallelToolCallsReassembleByIndex() {
        val events = run(
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"f","arguments":"{\"x\":1}"}}]}}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"g","arguments":"{\"y\":2}"}}]}}]}""",
            "[DONE]",
        )
        val calls = (events.last() as AssistantMessageEvent.Done).message.content.filterIsInstance<ToolCall>()
        assertThat(calls.map { it.name }).containsExactly("f", "g")
    }

    @Test
    fun errorChunkBecomesTerminalError() {
        val events = run("""{"error":{"message":"model busy"}}""")
        val err = events.last() as AssistantMessageEvent.Error
        assertThat(err.error.errorMessage).isEqualTo("model busy")
    }

    @Test
    fun closeWithoutDoneStillFinishes() {
        val p = SseAssistantParser(model)
        p.accept("""{"choices":[{"delta":{"content":"hi"}}]}""")
        assertThat(p.finish().single()).isInstanceOf(AssistantMessageEvent.Done::class.java)
    }
}
