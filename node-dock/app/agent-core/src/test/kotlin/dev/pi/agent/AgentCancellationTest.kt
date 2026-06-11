package dev.pi.agent

import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.AssistantMessageEventStream
import dev.pi.ai.Model
import dev.pi.ai.StopReason
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.Usage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Cancellation must unwind the loop silently — it is the USER interrupting
 * (barge-in / superseding utterance / turn timeout), not a model failure.
 *
 * Regression tests for the bug where `runWithLifecycle` caught
 * CancellationException and synthesized an error MessageEnd, which the dock
 * then spoke as "I couldn't reach my local model" after every interruption
 * (seen live in the obs traces as stopReason=ERROR steps with empty text).
 */
class AgentCancellationTest {

    private val model = Model("mock", "mock", "faux", "faux")

    private fun assistantText(text: String) = AssistantMessage(
        content = listOf(TextContent(text)),
        api = "faux", provider = "faux", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.STOP,
    )

    /** A stream that starts a message but never finishes (a hung model). */
    private fun hangingStream(scope: CoroutineScope): StreamFn = { _, _, _ ->
        val stream = AssistantMessageEventStream()
        scope.launch { stream.push(AssistantMessageEvent.Start(assistantText(""))) }
        stream
    }

    /** A stream that completes one text reply. */
    private fun scriptedStream(scope: CoroutineScope, text: String): StreamFn = { _, _, _ ->
        val stream = AssistantMessageEventStream()
        val msg = assistantText(text)
        scope.launch {
            stream.push(AssistantMessageEvent.Start(msg))
            stream.push(AssistantMessageEvent.Done(StopReason.STOP, msg))
        }
        stream
    }

    /** A stream that fails with a transport error. */
    private fun failingStream(scope: CoroutineScope): StreamFn = { _, _, _ ->
        val stream = AssistantMessageEventStream()
        val msg = AssistantMessage(
            content = listOf(TextContent("")),
            api = "faux", provider = "faux", model = "mock",
            usage = Usage.EMPTY, stopReason = StopReason.ERROR,
            errorMessage = "connection refused",
        )
        scope.launch { stream.push(AssistantMessageEvent.Error(StopReason.ERROR, msg)) }
        stream
    }

    private fun errorMessageEnds(events: List<AgentEvent>): List<AssistantMessage> =
        events.filterIsInstance<AgentEvent.MessageEnd>()
            .mapNotNull { it.message as? AssistantMessage }
            .filter { it.errorMessage != null }

    @Test
    fun `cancelling a hung stream emits no synthetic error events`() = runTest {
        val agent = Agent(AgentOptions(model = model, streamFn = hangingStream(this)))
        val events = mutableListOf<AgentEvent>()
        agent.subscribe { events.add(it) }

        val job = launch { agent.prompt("hello") }
        testScheduler.advanceUntilIdle()   // let the prompt start + hang
        job.cancel()
        job.join()

        assertEquals(emptyList(), errorMessageEnds(events),
            "cancellation must not synthesize an error MessageEnd")
        // The cancelled run must not pollute the transcript with a failure entry.
        assertTrue(agent.state.messages.filterIsInstance<AssistantMessage>()
            .none { it.errorMessage != null })
    }

    @Test
    fun `agent is reusable after a cancelled run`() = runTest {
        val agent = Agent(AgentOptions(model = model, streamFn = hangingStream(this)))
        val job = launch { agent.prompt("first") }
        testScheduler.advanceUntilIdle()
        job.cancel()
        job.join()

        // activeRun must be cleared by the cancelled run's finally.
        agent.streamFn = scriptedStream(this, "second answer")
        agent.prompt("second")   // must NOT throw AgentBusyException
        val texts = agent.state.messages.filterIsInstance<AssistantMessage>()
            .flatMap { it.content }.filterIsInstance<TextContent>().map { it.text }
        assertTrue("second answer" in texts)
    }

    @Test
    fun `cancelling during tool execution does not record a fake tool result`() = runTest {
        val hangingTool = object : AgentTool(
            name = "hang",
            description = "never returns",
            parameters = buildJsonObject {
                put("type", "object"); putJsonObject("properties") {}
            },
        ) {
            override suspend fun execute(
                toolCallId: String,
                params: JsonObject,
                onUpdate: AgentToolUpdateCallback?,
            ): AgentToolResult<Any?> {
                awaitCancellation()
            }
        }
        // Model script: call the hanging tool once.
        val callsTool: StreamFn = { _, _, _ ->
            val stream = AssistantMessageEventStream()
            val msg = AssistantMessage(
                content = listOf(ToolCall("tc-1", "hang", buildJsonObject {})),
                api = "faux", provider = "faux", model = "mock",
                usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
            )
            launch {
                stream.push(AssistantMessageEvent.Start(msg))
                stream.push(AssistantMessageEvent.Done(StopReason.TOOL_USE, msg))
            }
            stream
        }
        val agent = Agent(AgentOptions(model = model, tools = listOf(hangingTool), streamFn = callsTool))
        val events = mutableListOf<AgentEvent>()
        agent.subscribe { events.add(it) }

        val job = launch { agent.prompt("go") }
        testScheduler.advanceUntilIdle()   // reaches the hanging tool
        job.cancel()
        job.join()

        // No ToolExecutionEnd may be fabricated from the cancellation.
        assertEquals(emptyList(),
            events.filterIsInstance<AgentEvent.ToolExecutionEnd>().map { it.toolName },
            "a cancelled tool must not produce a fake error result")
        assertEquals(emptyList(), errorMessageEnds(events))
    }

    @Test
    fun `a real stream failure still emits the synthetic error MessageEnd`() = runTest {
        val agent = Agent(AgentOptions(model = model, streamFn = failingStream(this)))
        val events = mutableListOf<AgentEvent>()
        agent.subscribe { events.add(it) }

        agent.prompt("hello")

        assertTrue(errorMessageEnds(events).isNotEmpty(),
            "genuine failures must keep producing the error MessageEnd")
    }
}
