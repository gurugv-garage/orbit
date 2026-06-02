package dev.pi.agent.harness

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.StopReason
import dev.pi.ai.TextContent
import dev.pi.ai.Usage
import dev.pi.ai.UserMessage

/** Port of pi-agent-core test/harness/session-test-utils.ts. */

fun createUserMessage(text: String): AgentMessage = UserMessage(listOf(TextContent(text)))

fun createAssistantMessage(text: String): AgentMessage = AssistantMessage(
    content = listOf(TextContent(text)),
    api = "anthropic-messages",
    provider = "anthropic",
    model = "claude-sonnet-4-5",
    usage = Usage.EMPTY,
    stopReason = StopReason.STOP,
)
