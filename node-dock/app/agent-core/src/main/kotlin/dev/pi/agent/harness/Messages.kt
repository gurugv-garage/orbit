package dev.pi.agent.harness

import dev.pi.ai.AgentMessage
import dev.pi.ai.Content
import dev.pi.ai.Message
import dev.pi.ai.TextContent
import dev.pi.ai.UserMessage
import dev.pi.agent.CustomAgentMessage
import java.time.Instant

/**
 * Kotlin port of pi-agent-core `src/harness/messages.ts`.
 *
 * Custom transcript message types (custom / branch-summary / compaction-summary)
 * and the harness `convertToLlm` that folds them into plain user [Message]s.
 */

const val COMPACTION_SUMMARY_PREFIX =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
const val COMPACTION_SUMMARY_SUFFIX = "\n</summary>"

const val BRANCH_SUMMARY_PREFIX =
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n"
const val BRANCH_SUMMARY_SUFFIX = "</summary>"

/** An app-defined custom message carrying arbitrary content + details. */
class CustomMessage(
    val customType: String,
    val content: List<Content>,
    val display: Boolean,
    val details: Any? = null,
    timestamp: Long = dev.pi.ai.nowMsPublic(),
) : CustomAgentMessage("custom", timestamp)

/** A summary of a branch the conversation returned from. */
class BranchSummaryMessage(
    val summary: String,
    val fromId: String,
    timestamp: Long = dev.pi.ai.nowMsPublic(),
) : CustomAgentMessage("branchSummary", timestamp)

/** A summary of pre-compaction history. */
class CompactionSummaryMessage(
    val summary: String,
    val tokensBefore: Int,
    timestamp: Long = dev.pi.ai.nowMsPublic(),
) : CustomAgentMessage("compactionSummary", timestamp)

private fun isoToMs(iso: String): Long = Instant.parse(iso).toEpochMilli()

fun createBranchSummaryMessage(summary: String, fromId: String, timestamp: String): BranchSummaryMessage =
    BranchSummaryMessage(summary, fromId, isoToMs(timestamp))

fun createCompactionSummaryMessage(summary: String, tokensBefore: Int, timestamp: String): CompactionSummaryMessage =
    CompactionSummaryMessage(summary, tokensBefore, isoToMs(timestamp))

fun createCustomMessage(
    customType: String,
    content: List<Content>,
    display: Boolean,
    details: Any?,
    timestamp: String,
): CustomMessage = CustomMessage(customType, content, display, details, isoToMs(timestamp))

/** Harness convertToLlm: fold custom transcript entries into plain user messages. */
fun convertToLlm(messages: List<AgentMessage>): List<Message> = messages.mapNotNull { m ->
    when (m) {
        is Message -> m
        is CustomMessage -> UserMessage(m.content, m.timestamp)
        is BranchSummaryMessage ->
            UserMessage(listOf(TextContent(BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX)), m.timestamp)
        is CompactionSummaryMessage ->
            UserMessage(
                listOf(TextContent(COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX)),
                m.timestamp,
            )
        else -> null
    }
}
