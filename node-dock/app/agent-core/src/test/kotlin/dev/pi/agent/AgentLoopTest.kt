package dev.pi.agent

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.AssistantMessageEventStream
import dev.pi.ai.Message
import dev.pi.ai.Model
import dev.pi.ai.StopReason
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Usage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Port of pi-agent-core test/agent-loop.test.ts (the core tool-calling subset). */
class AgentLoopTest {

    private val model = Model("mock", "mock", "faux", "faux")

    private fun assistantText(text: String) = AssistantMessage(
        content = listOf(TextContent(text)),
        api = "faux", provider = "faux", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.STOP,
    )

    private fun assistantWithToolCall(id: String, name: String, args: JsonObject) = AssistantMessage(
        content = listOf(ToolCall(id, name, args)),
        api = "faux", provider = "faux", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
    )

    /** Scripts a sequence of assistant messages, one per loop turn. */
    private fun scriptStream(scope: CoroutineScope, responses: List<AssistantMessage>): StreamFn {
        val queue = ArrayDeque(responses)
        return { _, _, _ ->
            val stream = AssistantMessageEventStream()
            val msg = if (queue.isEmpty()) assistantText("done") else queue.removeFirst()
            scope.launch {
                stream.push(AssistantMessageEvent.Start(msg))
                stream.push(AssistantMessageEvent.Done(msg.stopReason, msg))
            }
            stream
        }
    }

    private fun echoSchema(): JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") { putJsonObject("value") { put("type", "string") } }
        putJsonArray("required") { add("value") }
    }

    private class RecordingTool(
        name: String,
        schema: JsonObject,
        private val terminate: Boolean = false,
        private val body: suspend (JsonObject) -> String = {
            (it["value"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: it["value"].toString()
        },
        executionMode: ToolExecutionMode? = null,
    ) : AgentTool(name, "test tool", schema, executionMode = executionMode) {
        val calls = mutableListOf<JsonObject>()
        override suspend fun execute(
            toolCallId: String,
            params: JsonObject,
            onUpdate: AgentToolUpdateCallback?,
        ): AgentToolResult<Any?> {
            calls.add(params)
            return AgentToolResult(listOf(TextContent(body(params))), details = emptyMap<String, Any?>(), terminate = if (terminate) true else null)
        }
    }

    private fun collector(): Pair<MutableList<AgentEvent>, AgentEventSink> {
        val events = mutableListOf<AgentEvent>()
        return events to AgentEventSink { events.add(it) }
    }

    private fun ctx(tools: List<AgentTool> = emptyList()) =
        AgentContext("sys", mutableListOf(), tools)

    private fun config(stream: StreamFn): AgentLoopConfig = AgentLoopConfig(
        model = model,
        convertToLlm = { msgs -> msgs.filterIsInstance<Message>() },
    )

    @Test
    fun `runs a single text turn and emits lifecycle events`() = runTest {
        val (events, sink) = collector()
        val stream = scriptStream(this, listOf(assistantText("hello")))
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("hi")),
            ctx(),
            config(stream),
            sink,
            stream,
        )
        // user prompt + assistant reply
        assertEquals(2, newMessages.size)
        assertTrue(newMessages.last() is AssistantMessage)
        assertTrue(events.first() is AgentEvent.AgentStart)
        assertTrue(events.last() is AgentEvent.AgentEnd)
    }

    @Test
    fun `executes a tool call and feeds the result back`() = runTest {
        val tool = RecordingTool("echo", echoSchema())
        // turn 1: model calls the tool; turn 2: model answers and stops.
        val stream = scriptStream(
            this,
            listOf(
                assistantWithToolCall("c1", "echo", buildJsonObject { put("value", "ping") }),
                assistantText("pong"),
            ),
        )
        val (events, sink) = collector()
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("call it")),
            ctx(listOf(tool)),
            config(stream),
            sink,
            stream,
        )

        assertEquals(1, tool.calls.size)
        assertEquals("ping", (tool.calls[0]["value"] as kotlinx.serialization.json.JsonPrimitive).content)

        val toolResult = newMessages.filterIsInstance<ToolResultMessage>().single()
        assertEquals("echo", toolResult.toolName)
        assertEquals(false, toolResult.isError)
        assertEquals("ping", (toolResult.content.first() as TextContent).text)

        assertTrue(events.any { it is AgentEvent.ToolExecutionStart })
        assertTrue(events.any { it is AgentEvent.ToolExecutionEnd })
    }

    @Test
    fun `unknown tool yields an error tool result`() = runTest {
        val stream = scriptStream(
            this,
            listOf(
                assistantWithToolCall("c1", "missing", buildJsonObject { put("value", "x") }),
                assistantText("ok"),
            ),
        )
        val (_, sink) = collector()
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("go")),
            ctx(emptyList()),
            config(stream),
            sink,
            stream,
        )
        val toolResult = newMessages.filterIsInstance<ToolResultMessage>().single()
        assertEquals(true, toolResult.isError)
        // Nudge: names the missing tool + tells the model how to recover.
        val text = (toolResult.content.first() as TextContent).text
        assertTrue(text.contains("missing"))
        assertTrue(text.contains("answer in words"))
    }

    @Test
    fun `terminate hint stops the loop after the tool batch`() = runTest {
        val tool = RecordingTool("stopper", echoSchema(), terminate = true)
        val stream = scriptStream(
            this,
            listOf(assistantWithToolCall("c1", "stopper", buildJsonObject { put("value", "x") })),
        )
        val (_, sink) = collector()
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("go")),
            ctx(listOf(tool)),
            config(stream),
            sink,
            stream,
        )
        // Loop terminated after the tool batch: no second assistant turn requested.
        assertEquals(1, tool.calls.size)
        assertEquals(1, newMessages.filterIsInstance<ToolResultMessage>().size)
    }

    @Test
    fun `beforeToolCall block produces an error result and skips execution`() = runTest {
        val tool = RecordingTool("echo", echoSchema())
        val stream = scriptStream(
            this,
            listOf(
                assistantWithToolCall("c1", "echo", buildJsonObject { put("value", "x") }),
                assistantText("done"),
            ),
        )
        val cfg = AgentLoopConfig(
            model = model,
            convertToLlm = { it.filterIsInstance<Message>() },
            beforeToolCall = { BeforeToolCallResult(block = true, reason = "nope") },
        )
        val (_, sink) = collector()
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("go")),
            ctx(listOf(tool)),
            cfg,
            sink,
            stream,
        )
        assertEquals(0, tool.calls.size)
        val toolResult = newMessages.filterIsInstance<ToolResultMessage>().single()
        assertEquals(true, toolResult.isError)
        assertEquals("nope", (toolResult.content.first() as TextContent).text)
    }

    @Test
    fun `validation failure on bad args yields an error result`() = runTest {
        val tool = RecordingTool("echo", echoSchema())
        // Missing required "value".
        val stream = scriptStream(
            this,
            listOf(
                assistantWithToolCall("c1", "echo", buildJsonObject { put("other", "x") }),
                assistantText("done"),
            ),
        )
        val (_, sink) = collector()
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("go")),
            ctx(listOf(tool)),
            config(stream),
            sink,
            stream,
        )
        assertEquals(0, tool.calls.size)
        val toolResult = newMessages.filterIsInstance<ToolResultMessage>().single()
        assertEquals(true, toolResult.isError)
        assertTrue((toolResult.content.first() as TextContent).text.contains("Validation failed"))
    }

    @Test
    fun `error stop reason ends the loop immediately`() = runTest {
        val errored = AssistantMessage(
            content = listOf(TextContent("")),
            api = "faux", provider = "faux", model = "mock",
            usage = Usage.EMPTY, stopReason = StopReason.ERROR, errorMessage = "boom",
        )
        val stream: StreamFn = { _, _, _ ->
            val s = AssistantMessageEventStream()
            launch {
                s.push(AssistantMessageEvent.Start(errored))
                s.push(AssistantMessageEvent.Error(StopReason.ERROR, errored))
            }
            s
        }
        val (events, sink) = collector()
        val newMessages = runAgentLoop(
            listOf(dev.pi.ai.UserMessage.text("go")),
            ctx(),
            config(stream),
            sink,
            stream,
        )
        assertTrue((newMessages.last() as AssistantMessage).stopReason == StopReason.ERROR)
        assertTrue(events.last() is AgentEvent.AgentEnd)
    }

    @Test
    fun `continue refuses when last message is assistant`() = runTest {
        val stream = scriptStream(this, emptyList())
        val context = AgentContext("sys", mutableListOf(assistantText("hi")))
        val (_, sink) = collector()
        var threw = false
        try {
            runAgentLoopContinue(context, config(stream), sink, stream)
        } catch (e: IllegalStateException) {
            threw = true
        }
        assertTrue(threw)
    }
}
