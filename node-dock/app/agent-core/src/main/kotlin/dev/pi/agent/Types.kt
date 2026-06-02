package dev.pi.agent

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.Content
import dev.pi.ai.Message
import dev.pi.ai.Model
import dev.pi.ai.SimpleStreamOptions
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Tool
import dev.pi.ai.nowMsPublic
import kotlinx.serialization.json.JsonObject

/**
 * Kotlin port of pi-agent-core `src/types.ts`.
 *
 * The agent runtime works in [AgentMessage]s and converts to LLM [Message]s
 * only at the provider boundary. Tools are [AgentTool]s; results are
 * [AgentToolResult]s; the loop emits [AgentEvent]s.
 */

/** A custom (non-LLM) transcript entry an app can inject. Filtered out by default convertToLlm. */
abstract class CustomAgentMessage(
    final override val role: String,
    override val timestamp: Long = nowMsPublic(),
) : AgentMessage

/** How multiple tool calls in one assistant message are executed. */
enum class ToolExecutionMode { SEQUENTIAL, PARALLEL }

/** How many queued messages are injected at a drain point. */
enum class QueueMode { ALL, ONE_AT_A_TIME }

/** Reasoning level for future turns (broader than ai.ThinkingLevel: includes "off"). */
enum class ThinkingLevel(val wire: String) {
    OFF("off"), MINIMAL("minimal"), LOW("low"), MEDIUM("medium"), HIGH("high"), XHIGH("xhigh");
    companion object { fun fromWire(s: String) = entries.first { it.wire == s } }
}

/** Final or partial result produced by a tool. */
data class AgentToolResult<T>(
    /** Text or image content returned to the model. */
    val content: List<Content>,
    /** Arbitrary structured details for logs / UI. */
    val details: T,
    /** Hint that the agent should stop after the current tool batch. */
    val terminate: Boolean? = null,
)

/** Callback a tool uses to stream partial execution updates. */
fun interface AgentToolUpdateCallback {
    operator fun invoke(partial: AgentToolResult<Any?>)
}

/** A tool the agent runtime can execute. */
abstract class AgentTool(
    name: String,
    description: String,
    parameters: JsonObject,
    /** Human-readable label for UI. */
    val label: String = name,
    /** Per-tool execution mode override. */
    val executionMode: ToolExecutionMode? = null,
) : Tool(name, description, parameters) {
    /** Optional shim for raw args before schema validation. Return an object matching the schema. */
    open fun prepareArguments(args: JsonObject): JsonObject = args

    /** Execute the call. Throw on failure (the loop encodes it as an error result). */
    abstract suspend fun execute(
        toolCallId: String,
        params: JsonObject,
        onUpdate: AgentToolUpdateCallback?,
    ): AgentToolResult<Any?>
}

/** Context snapshot handed to the low-level loop. */
data class AgentContext(
    val systemPrompt: String,
    val messages: MutableList<AgentMessage>,
    val tools: List<AgentTool>? = null,
)

// ---------------------------------------------------------------------------
// Hook contexts + results
// ---------------------------------------------------------------------------

data class BeforeToolCallResult(val block: Boolean = false, val reason: String? = null)

data class AfterToolCallResult(
    val content: List<Content>? = null,
    val details: Any? = null,
    val isError: Boolean? = null,
    val terminate: Boolean? = null,
)

data class BeforeToolCallContext(
    val assistantMessage: AssistantMessage,
    val toolCall: ToolCall,
    val args: JsonObject,
    val context: AgentContext,
)

data class AfterToolCallContext(
    val assistantMessage: AssistantMessage,
    val toolCall: ToolCall,
    val args: JsonObject,
    val result: AgentToolResult<Any?>,
    val isError: Boolean,
    val context: AgentContext,
)

data class ShouldStopAfterTurnContext(
    val message: AssistantMessage,
    val toolResults: List<ToolResultMessage>,
    val context: AgentContext,
    val newMessages: List<AgentMessage>,
)

/** Replacement runtime state for the next provider request. */
data class AgentLoopTurnUpdate(
    val context: AgentContext? = null,
    val model: Model? = null,
    val thinkingLevel: ThinkingLevel? = null,
)

/**
 * Configuration for one low-level loop run. Mirrors `AgentLoopConfig`.
 * Hooks must not throw — return a safe fallback instead.
 */
class AgentLoopConfig(
    val model: Model,
    val reasoning: dev.pi.ai.ThinkingLevel? = null,
    val streamOptions: SimpleStreamOptions = SimpleStreamOptions(),
    val toolExecution: ToolExecutionMode = ToolExecutionMode.PARALLEL,
    /** AgentMessage[] -> LLM Message[] for each request. */
    val convertToLlm: suspend (List<AgentMessage>) -> List<Message>,
    /** Optional AgentMessage-level transform before convertToLlm. */
    val transformContext: (suspend (List<AgentMessage>) -> List<AgentMessage>)? = null,
    val getApiKey: (suspend (provider: String) -> String?)? = null,
    val shouldStopAfterTurn: (suspend (ShouldStopAfterTurnContext) -> Boolean)? = null,
    val prepareNextTurn: (suspend (ShouldStopAfterTurnContext) -> AgentLoopTurnUpdate?)? = null,
    val getSteeringMessages: (suspend () -> List<AgentMessage>)? = null,
    val getFollowUpMessages: (suspend () -> List<AgentMessage>)? = null,
    val beforeToolCall: (suspend (BeforeToolCallContext) -> BeforeToolCallResult?)? = null,
    val afterToolCall: (suspend (AfterToolCallContext) -> AfterToolCallResult?)? = null,
)

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Events emitted by the loop / Agent for UI updates. */
sealed interface AgentEvent {
    data object AgentStart : AgentEvent
    data class AgentEnd(val messages: List<AgentMessage>) : AgentEvent
    data object TurnStart : AgentEvent
    data class TurnEnd(val message: AgentMessage, val toolResults: List<ToolResultMessage>) : AgentEvent
    data class MessageStart(val message: AgentMessage) : AgentEvent
    data class MessageUpdate(
        val message: AgentMessage,
        val assistantMessageEvent: dev.pi.ai.AssistantMessageEvent,
    ) : AgentEvent
    data class MessageEnd(val message: AgentMessage) : AgentEvent
    data class ToolExecutionStart(val toolCallId: String, val toolName: String, val args: JsonObject) : AgentEvent
    data class ToolExecutionUpdate(
        val toolCallId: String,
        val toolName: String,
        val args: JsonObject,
        val partialResult: AgentToolResult<Any?>,
    ) : AgentEvent
    data class ToolExecutionEnd(
        val toolCallId: String,
        val toolName: String,
        val result: AgentToolResult<Any?>,
        val isError: Boolean,
    ) : AgentEvent
}
