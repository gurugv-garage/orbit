package dev.pi.agent.harness

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.ImageContent
import dev.pi.ai.Message
import dev.pi.ai.StopReason
import dev.pi.ai.TextContent
import dev.pi.ai.ThinkingContent
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Usage
import dev.pi.ai.UserMessage
import kotlin.math.ceil

/**
 * Kotlin port of the token-accounting + serialization helpers from
 * pi-agent-core `src/harness/compaction/compaction.ts` and `utils.ts`.
 *
 * These are the model-independent pieces of compaction: estimate how many
 * tokens a context occupies, decide whether to compact, and serialize a
 * conversation to plain text for a summarization prompt. The summarization LLM
 * call itself (`generateSummary`) and the session-tree cut-point machinery are
 * out of scope here.
 */

data class CompactionSettings(
    val enabled: Boolean,
    val reserveTokens: Int,
    val keepRecentTokens: Int,
)

val DEFAULT_COMPACTION_SETTINGS = CompactionSettings(
    enabled = true,
    reserveTokens = 16384,
    keepRecentTokens = 20000,
)

/** Total context tokens from provider usage. */
fun calculateContextTokens(usage: Usage): Int =
    if (usage.totalTokens != 0) usage.totalTokens
    else usage.input + usage.output + usage.cacheRead + usage.cacheWrite

private fun assistantUsage(msg: AgentMessage): Usage? {
    if (msg is AssistantMessage && msg.stopReason != StopReason.ABORTED && msg.stopReason != StopReason.ERROR) {
        return msg.usage
    }
    return null
}

/** Whether context usage exceeds the configured compaction threshold. */
fun shouldCompact(contextTokens: Int, contextWindow: Int, settings: CompactionSettings): Boolean {
    if (!settings.enabled) return false
    return contextTokens > contextWindow - settings.reserveTokens
}

private const val ESTIMATED_IMAGE_CHARS = 4800

private fun estimateTextAndImageContentChars(content: List<dev.pi.ai.Content>): Int {
    var chars = 0
    for (block in content) when (block) {
        is TextContent -> chars += block.text.length
        is ImageContent -> chars += ESTIMATED_IMAGE_CHARS
        else -> {}
    }
    return chars
}

private fun jsonArgsLength(args: kotlinx.serialization.json.JsonObject): Int = args.toString().length

/** Estimate token count for one message using a conservative char heuristic (chars/4). */
fun estimateTokens(message: AgentMessage): Int {
    var chars = 0
    return when (message) {
        is UserMessage -> ceil(estimateTextAndImageContentChars(message.content) / 4.0).toInt()
        is AssistantMessage -> {
            for (block in message.content) when (block) {
                is TextContent -> chars += block.text.length
                is ThinkingContent -> chars += block.thinking.length
                is ToolCall -> chars += block.name.length + jsonArgsLength(block.arguments)
                else -> {}
            }
            ceil(chars / 4.0).toInt()
        }
        is ToolResultMessage -> ceil(estimateTextAndImageContentChars(message.content) / 4.0).toInt()
        is CustomMessage -> ceil(estimateTextAndImageContentChars(message.content) / 4.0).toInt()
        is BranchSummaryMessage -> ceil(message.summary.length / 4.0).toInt()
        is CompactionSummaryMessage -> ceil(message.summary.length / 4.0).toInt()
        else -> 0
    }
}

data class ContextUsageEstimate(
    val tokens: Int,
    val usageTokens: Int,
    val trailingTokens: Int,
    val lastUsageIndex: Int?,
)

/** Estimate context tokens, preferring the most recent provider usage block. */
fun estimateContextTokens(messages: List<AgentMessage>): ContextUsageEstimate {
    var usageIndex: Int? = null
    var usage: Usage? = null
    for (i in messages.indices.reversed()) {
        val u = assistantUsage(messages[i])
        if (u != null) { usageIndex = i; usage = u; break }
    }

    if (usageIndex == null || usage == null) {
        val estimated = messages.sumOf { estimateTokens(it) }
        return ContextUsageEstimate(estimated, 0, estimated, null)
    }

    val usageTokens = calculateContextTokens(usage)
    var trailing = 0
    for (i in usageIndex + 1 until messages.size) trailing += estimateTokens(messages[i])
    return ContextUsageEstimate(usageTokens + trailing, usageTokens, trailing, usageIndex)
}

// ---------------------------------------------------------------------------
// Serialization for summarization prompts (port of utils.serializeConversation)
// ---------------------------------------------------------------------------

private const val TOOL_RESULT_MAX_CHARS = 2000

private fun truncateForSummary(text: String, maxChars: Int): String {
    if (text.length <= maxChars) return text
    val truncatedChars = text.length - maxChars
    return "${text.substring(0, maxChars)}\n\n[... $truncatedChars more characters truncated]"
}

private fun textOf(content: List<dev.pi.ai.Content>): String =
    content.filterIsInstance<TextContent>().joinToString("") { it.text }

/** Serialize LLM messages to plain text for summarization prompts. */
fun serializeConversation(messages: List<Message>): String {
    val parts = mutableListOf<String>()
    for (msg in messages) when (msg) {
        is UserMessage -> {
            val content = textOf(msg.content)
            if (content.isNotEmpty()) parts.add("[User]: $content")
        }
        is AssistantMessage -> {
            val textParts = mutableListOf<String>()
            val thinkingParts = mutableListOf<String>()
            val toolCalls = mutableListOf<String>()
            for (block in msg.content) when (block) {
                is TextContent -> textParts.add(block.text)
                is ThinkingContent -> thinkingParts.add(block.thinking)
                is ToolCall -> {
                    val argsStr = block.arguments.entries.joinToString(", ") { (k, v) -> "$k=$v" }
                    toolCalls.add("${block.name}($argsStr)")
                }
                else -> {}
            }
            if (thinkingParts.isNotEmpty()) parts.add("[Assistant thinking]: ${thinkingParts.joinToString("\n")}")
            if (textParts.isNotEmpty()) parts.add("[Assistant]: ${textParts.joinToString("\n")}")
            if (toolCalls.isNotEmpty()) parts.add("[Assistant tool calls]: ${toolCalls.joinToString("; ")}")
        }
        is ToolResultMessage -> {
            val content = textOf(msg.content)
            if (content.isNotEmpty()) parts.add("[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}")
        }
    }
    return parts.joinToString("\n\n")
}
