package dev.pi.agent

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
import dev.pi.ai.UserMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * How to test AGENTIC, MULTI-STEP flows deterministically — one prompt that
 * drives several turns of tool calls — without a live model.
 *
 * The trick: a "scripted model" whose next reply is a *function of the running
 * transcript*. It inspects the latest tool result and decides whether to call
 * the tool again or stop. That reproduces a real model's turn-by-turn loop
 * (call -> observe result -> decide next call -> ... -> answer), but it's fully
 * deterministic, fast, and asserts on the exact step sequence.
 */
class MultiStepAgentTest {

    private val model = Model("mock", "mock", "faux", "faux")

    /** A counter tool: returns whatever number it's told to "set" to. */
    private class CounterTool : AgentTool(
        name = "step",
        description = "Advance one step; returns the given number.",
        parameters = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") { putJsonObject("n") { put("type", "number") } }
            putJsonArray("required") { add("n") }
        },
    ) {
        var calls = 0
        override suspend fun execute(
            toolCallId: String,
            params: JsonObject,
            onUpdate: AgentToolUpdateCallback?,
        ): AgentToolResult<Any?> {
            calls++
            val n = params["n"]?.jsonPrimitive?.content ?: "0"
            return AgentToolResult(listOf(TextContent(n)), details = emptyMap<String, Any?>())
        }
    }

    private fun assistantToolCall(id: String, n: Int) = AssistantMessage(
        content = listOf(ToolCall(id, "step", buildJsonObject { put("n", n) })),
        api = "faux", provider = "faux", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
    )

    private fun assistantText(text: String) = AssistantMessage(
        content = listOf(TextContent(text)),
        api = "faux", provider = "faux", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.STOP,
    )

    /**
     * Scripted model that loops: each turn it reads the last tool result and, if
     * the counter is below [target], calls `step` again with result+1. When the
     * counter reaches [target] it stops with a final text answer.
     *
     * This is genuine turn-by-turn agentic behavior: the Nth call depends on the
     * (N-1)th result, exactly like a real model deciding its next move.
     */
    private fun loopingModel(scope: CoroutineScope, target: Int): StreamFn = { _, context, _ ->
        val stream = AssistantMessageEventStream()
        val lastResult = context.messages
            .filterIsInstance<ToolResultMessage>()
            .lastOrNull()
            ?.content?.filterIsInstance<TextContent>()?.firstOrNull()?.text?.toIntOrNull()

        val msg = when {
            lastResult == null -> assistantToolCall("c1", 1)               // first move
            lastResult < target -> assistantToolCall("c${lastResult + 1}", lastResult + 1)
            else -> assistantText("Done — reached $lastResult.")           // stop
        }
        scope.launch {
            stream.push(AssistantMessageEvent.Start(msg))
            stream.push(AssistantMessageEvent.Done(msg.stopReason, msg))
        }
        stream
    }

    @Test
    fun `one prompt drives N sequential tool-call turns until the model stops`() = runTest {
        val tool = CounterTool()
        val target = 4
        val turns = mutableListOf<String>()

        val agent = Agent(
            AgentOptions(
                model = model,
                tools = listOf(tool),
                streamFn = loopingModel(this, target),
                convertToLlm = { msgs -> msgs.filterIsInstance<Message>() },
            ),
        )
        agent.subscribe { e ->
            when (e) {
                is AgentEvent.ToolExecutionStart -> turns.add("call:${e.args["n"]?.jsonPrimitive?.content}")
                is AgentEvent.AgentEnd -> turns.add("end")
                else -> {}
            }
        }

        agent.prompt("count to $target using the step tool")

        // The tool was called once per step, in order, then the model stopped.
        assertEquals(target, tool.calls)
        assertEquals(listOf("call:1", "call:2", "call:3", "call:4", "end"), turns)

        // Final assistant message is the stop text, and the transcript holds all
        // the intermediate tool results.
        val last = agent.state.messages.last() as AssistantMessage
        assertTrue((last.content.first() as TextContent).text.contains("reached 4"))
        assertEquals(target, agent.state.messages.filterIsInstance<ToolResultMessage>().size)
    }

    @Test
    fun `terminate from a tool stops the multi-step loop early`() = runTest {
        // A tool that signals terminate=true ends the batch even if the model
        // would otherwise keep going.
        val stopperCalls = intArrayOf(0)
        val stopper = object : AgentTool(
            "halt", "stop now", buildJsonObject { put("type", "object"); putJsonObject("properties") {} },
        ) {
            override suspend fun execute(
                toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?,
            ): AgentToolResult<Any?> {
                stopperCalls[0]++
                return AgentToolResult(listOf(TextContent("halted")), details = emptyMap<String, Any?>(), terminate = true)
            }
        }
        val stream: StreamFn = { _, _, _ ->
            val s = AssistantMessageEventStream()
            val msg = AssistantMessage(
                content = listOf(ToolCall("c1", "halt", buildJsonObject {})),
                api = "faux", provider = "faux", model = "mock", usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
            )
            launch { s.push(AssistantMessageEvent.Start(msg)); s.push(AssistantMessageEvent.Done(msg.stopReason, msg)) }
            s
        }
        val agent = Agent(
            AgentOptions(
                model = model, tools = listOf(stopper), streamFn = stream,
                convertToLlm = { it.filterIsInstance<Message>() },
            ),
        )
        agent.prompt("go")
        // Tool ran exactly once; the loop did not request another turn.
        assertEquals(1, stopperCalls[0])
        assertEquals(1, agent.state.messages.filterIsInstance<ToolResultMessage>().size)
    }
}
