package dev.pi.ai

import kotlinx.serialization.json.JsonObject

/**
 * Kotlin port of the slice of `@earendil-works/pi-ai` that `pi-agent-core`
 * depends on: the message/content model, the model descriptor, the streaming
 * event protocol, and tool definitions.
 *
 * The original is a multi-provider TypeScript LLM client. Here we keep only the
 * transport-agnostic data types the agent loop touches. Provider plumbing (18
 * SSE/WebSocket dialects, OAuth, image generation) is intentionally omitted.
 *
 * Discriminated unions (`type: "text" | "image" | ...`) become sealed
 * hierarchies. `Record<string, any>` tool arguments become [JsonObject].
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/** A block of content inside a user/assistant/tool-result message. */
sealed interface Content

/** Plain text content. */
data class TextContent(
    val text: String,
    /** Provider-specific opaque metadata (e.g. OpenAI responses message id). */
    val textSignature: String? = null,
) : Content

/** Model reasoning/thinking content. */
data class ThinkingContent(
    val thinking: String,
    val thinkingSignature: String? = null,
    /** True when redacted by safety filters; opaque payload lives in the signature. */
    val redacted: Boolean = false,
) : Content

/** Base64 image content. */
data class ImageContent(
    val data: String,
    val mimeType: String,
) : Content

/** A tool/function call requested by the assistant. */
data class ToolCall(
    val id: String,
    val name: String,
    val arguments: JsonObject,
    /** Google-specific opaque signature for reusing thought context. */
    val thoughtSignature: String? = null,
) : Content

// ---------------------------------------------------------------------------
// Usage + stop reasons
// ---------------------------------------------------------------------------

data class Cost(
    val input: Double = 0.0,
    val output: Double = 0.0,
    val cacheRead: Double = 0.0,
    val cacheWrite: Double = 0.0,
    val total: Double = 0.0,
)

data class Usage(
    val input: Int = 0,
    val output: Int = 0,
    val cacheRead: Int = 0,
    val cacheWrite: Int = 0,
    val totalTokens: Int = 0,
    val cost: Cost = Cost(),
) {
    companion object {
        val EMPTY = Usage()
    }
}

enum class StopReason(val wire: String) {
    STOP("stop"),
    LENGTH("length"),
    TOOL_USE("toolUse"),
    ERROR("error"),
    ABORTED("aborted");

    companion object {
        fun fromWire(s: String): StopReason = entries.first { it.wire == s }
    }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Marker for anything that can live in an agent transcript.
 *
 * In the TS original `AgentMessage = Message | CustomAgentMessages[...]` via
 * declaration merging. Here LLM [Message]s implement this marker directly, and
 * apps can add custom transcript entries by implementing it too (see
 * `CustomAgentMessage` in the agent package).
 */
interface AgentMessage {
    /** Discriminator used by `convertToLlm` filters: user/assistant/toolResult/custom. */
    val role: String
    val timestamp: Long
}

/** Role-tagged conversation message understood by an LLM. */
sealed interface Message : AgentMessage {
    override val timestamp: Long
}

/** A message from the user. Content is text and/or images. */
data class UserMessage(
    val content: List<Content>,
    override val timestamp: Long = nowMs(),
) : Message {
    override val role: String get() = "user"

    companion object {
        fun text(text: String, timestamp: Long = nowMs()): UserMessage =
            UserMessage(listOf(TextContent(text)), timestamp)
    }
}

/** A full assistant response. Content is text, thinking, and tool calls. */
data class AssistantMessage(
    val content: List<Content>,
    val api: String,
    val provider: String,
    val model: String,
    val usage: Usage,
    val stopReason: StopReason,
    val responseModel: String? = null,
    val responseId: String? = null,
    val errorMessage: String? = null,
    override val timestamp: Long = nowMs(),
) : Message {
    override val role: String get() = "assistant"
}

/** Result of executing a tool, fed back to the model. */
data class ToolResultMessage(
    val toolCallId: String,
    val toolName: String,
    val content: List<Content>,
    val isError: Boolean,
    val details: Any? = null,
    override val timestamp: Long = nowMs(),
) : Message {
    override val role: String get() = "toolResult"
}

// ---------------------------------------------------------------------------
// Tools, model, context
// ---------------------------------------------------------------------------

/** A tool the model may call. `parameters` is a JSON-schema object. */
open class Tool(
    val name: String,
    val description: String,
    val parameters: JsonObject,
)

data class ModelCost(
    val input: Double = 0.0,
    val output: Double = 0.0,
    val cacheRead: Double = 0.0,
    val cacheWrite: Double = 0.0,
)

/** Descriptor for an LLM. Only the fields the agent loop reads are kept. */
data class Model(
    val id: String,
    val name: String,
    val api: String,
    val provider: String,
    val baseUrl: String = "",
    val reasoning: Boolean = false,
    val input: List<String> = emptyList(),
    val cost: ModelCost = ModelCost(),
    val contextWindow: Int = 0,
    val maxTokens: Int = 0,
) {
    companion object {
        /** Matches `DEFAULT_MODEL` in agent.ts. */
        val UNKNOWN = Model(
            id = "unknown",
            name = "unknown",
            api = "unknown",
            provider = "unknown",
        )
    }
}

/** The request context handed to a stream function. */
data class Context(
    val systemPrompt: String? = null,
    val messages: List<Message>,
    val tools: List<Tool>? = null,
)

/** Reasoning level requested for a turn (token in agent types is broader). */
enum class ThinkingLevel(val wire: String) {
    OFF("off"),
    MINIMAL("minimal"),
    LOW("low"),
    MEDIUM("medium"),
    HIGH("high"),
    XHIGH("xhigh");

    companion object {
        fun fromWire(s: String): ThinkingLevel = entries.first { it.wire == s }
    }
}

/** Options passed to the stream function. Mirrors `SimpleStreamOptions`. */
data class SimpleStreamOptions(
    val reasoning: ThinkingLevel? = null,
    val apiKey: String? = null,
    val sessionId: String? = null,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
)

internal fun nowMs(): Long = System.currentTimeMillis()

/** Public wall-clock millis, for callers building messages outside this module. */
fun nowMsPublic(): Long = System.currentTimeMillis()
