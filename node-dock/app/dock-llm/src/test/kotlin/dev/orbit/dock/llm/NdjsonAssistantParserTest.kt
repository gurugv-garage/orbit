package dev.orbit.dock.llm

import com.google.common.truth.Truth.assertThat
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.Model
import dev.pi.ai.StopReason
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test

/**
 * Parser that turns Ollama `/api/chat` NDJSON lines into AssistantMessageEvents.
 * Mirrors the wire shapes observed live from gemma/glm (content streamed as
 * deltas; tool_calls arrive as whole objects). No socket — fed JSON objects.
 */
class NdjsonAssistantParserTest {

    private val model = Model("gemma4:e2b", "gemma4:e2b", "openai-completions", "ollama")
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private fun line(s: String) = json.parseToJsonElement(s).jsonObject

    private fun run(vararg lines: String): List<AssistantMessageEvent> {
        val p = NdjsonAssistantParser(model)
        return lines.flatMap { p.accept(line(it)) }
    }

    @Test
    fun streamsContentAsTextDeltasThenDone() {
        val events = run(
            """{"message":{"role":"assistant","content":"Hi "}}""",
            """{"message":{"role":"assistant","content":"there"}}""",
            """{"message":{"role":"assistant","content":""},"done":true}""",
        )
        assertThat(events.first()).isInstanceOf(AssistantMessageEvent.Start::class.java)
        val deltas = events.filterIsInstance<AssistantMessageEvent.TextDelta>().map { it.delta }
        assertThat(deltas).containsExactly("Hi ", "there").inOrder()
        val done = events.last() as AssistantMessageEvent.Done
        assertThat((done.message.content.first() as TextContent).text).isEqualTo("Hi there")
        assertThat(done.message.stopReason).isEqualTo(StopReason.STOP)
    }

    @Test
    fun emitsWholeToolCallAndToolUseStop() {
        val events = run(
            """{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"move_body","arguments":{"part":"neck","state":"lookDown"}}}]}}""",
            """{"message":{"role":"assistant","content":""},"done":true}""",
        )
        val end = events.filterIsInstance<AssistantMessageEvent.ToolCallEnd>().single()
        assertThat(end.toolCall.name).isEqualTo("move_body")
        assertThat(end.toolCall.arguments["part"]?.jsonPrimitive?.content).isEqualTo("neck")
        assertThat(end.toolCall.arguments["state"]?.jsonPrimitive?.content).isEqualTo("lookDown")
        val done = events.last() as AssistantMessageEvent.Done
        assertThat(done.message.stopReason).isEqualTo(StopReason.TOOL_USE)
        assertThat(done.message.content.filterIsInstance<ToolCall>()).hasSize(1)
    }

    @Test
    fun handlesContentAndToolCallInSameTurn() {
        // The "narrate while acting" shape — prose plus a tool call.
        val events = run(
            """{"message":{"role":"assistant","content":"Looking down. "}}""",
            """{"message":{"role":"assistant","tool_calls":[{"function":{"name":"move_body","arguments":{"part":"neck","state":"lookDown"}}}]}}""",
            """{"message":{"content":""},"done":true}""",
        )
        assertThat(events.filterIsInstance<AssistantMessageEvent.TextDelta>()).isNotEmpty()
        assertThat(events.filterIsInstance<AssistantMessageEvent.ToolCallEnd>()).hasSize(1)
        val done = events.last() as AssistantMessageEvent.Done
        assertThat(done.message.stopReason).isEqualTo(StopReason.TOOL_USE)
    }

    @Test
    fun finishWithoutDoneStillTerminates() {
        val p = NdjsonAssistantParser(model)
        p.accept(line("""{"message":{"content":"hi"}}"""))
        val tail = p.finish()
        assertThat(tail.single()).isInstanceOf(AssistantMessageEvent.Done::class.java)
    }

    @Test
    fun ignoresFurtherLinesAfterDone() {
        val p = NdjsonAssistantParser(model)
        p.accept(line("""{"message":{"content":"a"}}"""))
        p.accept(line("""{"message":{"content":""},"done":true}"""))
        assertThat(p.accept(line("""{"message":{"content":"late"}}"""))).isEmpty()
    }
}
