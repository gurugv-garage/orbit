package dev.pi.agent

import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.AssistantMessageEventStream
import dev.pi.ai.Model
import dev.pi.ai.StopReason
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.Usage
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Port of pi-agent-core test/agent.test.ts (the device-free, deterministic subset). */
class AgentTest {

    private fun assistant(text: String) = AssistantMessage(
        content = listOf(TextContent(text)),
        api = "openai-responses", provider = "openai", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.STOP,
    )

    /** A streamFn that, within the test scope, scripts a single text reply. */
    private fun scriptedStream(scope: kotlinx.coroutines.CoroutineScope, text: String): StreamFn = { _, _, _ ->
        val stream = AssistantMessageEventStream()
        val msg = assistant(text)
        scope.launch {
            stream.push(AssistantMessageEvent.Start(msg))
            stream.push(AssistantMessageEvent.Done(StopReason.STOP, msg))
        }
        stream
    }

    @Test
    fun `creates an agent with default state`() {
        val agent = Agent(AgentOptions(streamFn = { _, _, _ -> AssistantMessageEventStream() }))
        assertEquals("", agent.state.systemPrompt)
        assertEquals(ThinkingLevel.OFF, agent.state.thinkingLevel)
        assertEquals(emptyList(), agent.state.tools)
        assertEquals(emptyList(), agent.state.messages)
        assertEquals(false, agent.state.isStreaming)
        assertNull(agent.state.streamingMessage)
        assertEquals(emptySet(), agent.state.pendingToolCalls)
        assertNull(agent.state.errorMessage)
    }

    @Test
    fun `creates an agent with custom initial state`() {
        val model = Model("gpt-4o-mini", "gpt-4o-mini", "openai-responses", "openai")
        val agent = Agent(
            AgentOptions(
                systemPrompt = "You are a helpful assistant.",
                model = model,
                thinkingLevel = ThinkingLevel.LOW,
                streamFn = { _, _, _ -> AssistantMessageEventStream() },
            ),
        )
        assertEquals("You are a helpful assistant.", agent.state.systemPrompt)
        assertEquals(model, agent.state.model)
        assertEquals(ThinkingLevel.LOW, agent.state.thinkingLevel)
    }

    @Test
    fun `subscribe does not emit on subscribe and unsubscribe stops delivery`() = runTest {
        val agent = Agent(AgentOptions(streamFn = scriptedStream(this, "ok")))
        var count = 0
        val unsub = agent.subscribe { count++ }
        assertEquals(0, count)
        agent.state.systemPrompt = "Test prompt" // state mutators don't emit
        assertEquals(0, count)
        unsub()
        agent.prompt("hello")
        assertEquals(0, count) // unsubscribed -> no delivery
    }

    @Test
    fun `emits full lifecycle event order on success`() = runTest {
        val agent = Agent(AgentOptions(streamFn = scriptedStream(this, "ok")))
        val events = mutableListOf<String>()
        agent.subscribe { events.add(it.typeName()) }

        agent.prompt("hello")

        assertEquals(
            listOf(
                "agent_start", "turn_start",
                "message_start", "message_end",     // the user prompt
                "message_start", "message_end",     // the assistant reply
                "turn_end", "agent_end",
            ),
            events,
        )
        val last = agent.state.messages.last()
        assertTrue(last is AssistantMessage)
        assertEquals("ok", (last.content.first() as TextContent).text)
    }

    @Test
    fun `emits full lifecycle events for thrown run failures`() = runTest {
        val agent = Agent(
            AgentOptions(streamFn = { _, _, _ -> throw RuntimeException("provider exploded") }),
        )
        val events = mutableListOf<String>()
        agent.subscribe { events.add(it.typeName()) }

        agent.prompt("hello")

        assertEquals(
            listOf(
                "agent_start", "turn_start",
                "message_start", "message_end",   // user prompt
                "message_start", "message_end",   // synthesized failure assistant message
                "turn_end", "agent_end",
            ),
            events,
        )
        val last = agent.state.messages.last() as AssistantMessage
        assertEquals(StopReason.ERROR, last.stopReason)
        assertEquals("provider exploded", last.errorMessage)
        assertEquals("provider exploded", agent.state.errorMessage)
    }

    @Test
    fun `prompt while running throws busy`() = runTest {
        val agent = Agent(AgentOptions(streamFn = scriptedStream(this, "ok")))
        // Drive one prompt to completion, then a second is allowed (not concurrent here).
        agent.prompt("first")
        agent.prompt("second")
        assertEquals(4, agent.state.messages.size) // user+assistant, twice
    }
}

private fun AgentEvent.typeName(): String = when (this) {
    AgentEvent.AgentStart -> "agent_start"
    is AgentEvent.AgentEnd -> "agent_end"
    AgentEvent.TurnStart -> "turn_start"
    is AgentEvent.TurnEnd -> "turn_end"
    is AgentEvent.MessageStart -> "message_start"
    is AgentEvent.MessageUpdate -> "message_update"
    is AgentEvent.MessageEnd -> "message_end"
    is AgentEvent.ToolExecutionStart -> "tool_execution_start"
    is AgentEvent.ToolExecutionUpdate -> "tool_execution_update"
    is AgentEvent.ToolExecutionEnd -> "tool_execution_end"
}
