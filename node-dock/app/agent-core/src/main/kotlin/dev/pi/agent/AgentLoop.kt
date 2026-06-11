package dev.pi.agent

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.Context
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.ToolValidationException
import dev.pi.ai.validateToolArguments
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.cancellation.CancellationException

/**
 * Kotlin port of pi-agent-core `src/agent-loop.ts`.
 *
 * The loop works in [AgentMessage]s and converts to LLM messages only at the
 * provider boundary. It streams an assistant response, executes any tool calls
 * (sequential or parallel), emits lifecycle [AgentEvent]s, and supports
 * steering / follow-up message injection between steps.
 *
 * Vocabulary (see agent-core/AGENT-MODEL.md): one `prompt()` is a **turn**
 * (bracketed by `TurnStart`/`TurnEnd`); each LLM call + its tool executions is a
 * **step** (`StepStart`/`StepEnd`). A turn is one or more steps — step N+1
 * happens only because step N's response contained tool calls.
 *
 * The TS uses `AbortSignal`; here cancellation is cooperative via coroutine
 * cancellation, so there is no explicit signal parameter — cancel the calling
 * coroutine to abort.
 */

/** Sink the loop emits events to. */
fun interface AgentEventSink {
    suspend fun emit(event: AgentEvent)
}

/**
 * Start a loop with a new prompt. The prompt is added to the context and
 * lifecycle events are emitted for it. Returns the new messages produced.
 */
suspend fun runAgentLoop(
    prompts: List<AgentMessage>,
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    streamFn: StreamFn,
): List<AgentMessage> {
    val newMessages = prompts.toMutableList()
    val currentContext = context.copy(
        messages = (context.messages + prompts).toMutableList(),
    )

    emit.emit(AgentEvent.TurnStart)
    emit.emit(AgentEvent.StepStart)
    for (prompt in prompts) {
        emit.emit(AgentEvent.MessageStart(prompt))
        emit.emit(AgentEvent.MessageEnd(prompt))
    }

    runLoop(currentContext, newMessages, config, emit, streamFn)
    return newMessages
}

/**
 * Continue from the current context without adding a message. The last message
 * must convert to a user/tool-result message or the provider will reject it.
 */
suspend fun runAgentLoopContinue(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    streamFn: StreamFn,
): List<AgentMessage> {
    if (context.messages.isEmpty()) throw IllegalStateException("Cannot continue: no messages in context")
    if (context.messages.last().role == "assistant") {
        throw IllegalStateException("Cannot continue from message role: assistant")
    }

    val newMessages = mutableListOf<AgentMessage>()
    val currentContext = context.copy(messages = context.messages.toMutableList())

    emit.emit(AgentEvent.TurnStart)
    emit.emit(AgentEvent.StepStart)

    runLoop(currentContext, newMessages, config, emit, streamFn)
    return newMessages
}

private suspend fun runLoop(
    initialContext: AgentContext,
    newMessages: MutableList<AgentMessage>,
    initialConfig: AgentLoopConfig,
    emit: AgentEventSink,
    streamFn: StreamFn,
) {
    var currentContext = initialContext
    var config = initialConfig
    var firstStep = true
    var pendingMessages: List<AgentMessage> = config.getSteeringMessages?.invoke() ?: emptyList()

    // Outer loop: continues when queued follow-up messages arrive after the agent would stop.
    while (true) {
        var hasMoreToolCalls = true

        // Inner loop: process tool calls and steering messages.
        while (hasMoreToolCalls || pendingMessages.isNotEmpty()) {
            if (!firstStep) emit.emit(AgentEvent.StepStart) else firstStep = false

            if (pendingMessages.isNotEmpty()) {
                for (message in pendingMessages) {
                    emit.emit(AgentEvent.MessageStart(message))
                    emit.emit(AgentEvent.MessageEnd(message))
                    currentContext.messages.add(message)
                    newMessages.add(message)
                }
                pendingMessages = emptyList()
            }

            val message = streamAssistantResponse(currentContext, config, emit, streamFn)
            newMessages.add(message)

            if (message.stopReason == dev.pi.ai.StopReason.ERROR ||
                message.stopReason == dev.pi.ai.StopReason.ABORTED
            ) {
                emit.emit(AgentEvent.StepEnd(message, emptyList()))
                emit.emit(AgentEvent.TurnEnd(newMessages.toList()))
                return
            }

            val toolCalls = message.content.filterIsInstance<ToolCall>()
            val toolResults = mutableListOf<ToolResultMessage>()
            hasMoreToolCalls = false
            if (toolCalls.isNotEmpty()) {
                val batch = executeToolCalls(currentContext, message, toolCalls, config, emit)
                toolResults.addAll(batch.messages)
                hasMoreToolCalls = !batch.terminate
                for (result in toolResults) {
                    currentContext.messages.add(result)
                    newMessages.add(result)
                }
            }

            emit.emit(AgentEvent.StepEnd(message, toolResults))

            val nextStepContext = ShouldStopAfterStepContext(message, toolResults, currentContext, newMessages)
            val snapshot = config.prepareNextStep?.invoke(nextStepContext)
            if (snapshot != null) {
                currentContext = snapshot.context ?: currentContext
                config = config.withNextStep(snapshot)
            }

            if (config.shouldStopAfterStep?.invoke(nextStepContext) == true) {
                emit.emit(AgentEvent.TurnEnd(newMessages.toList()))
                return
            }

            pendingMessages = config.getSteeringMessages?.invoke() ?: emptyList()
        }

        val followUp = config.getFollowUpMessages?.invoke() ?: emptyList()
        if (followUp.isNotEmpty()) {
            pendingMessages = followUp
            continue
        }
        break
    }

    emit.emit(AgentEvent.TurnEnd(newMessages.toList()))
}

private fun AgentLoopConfig.withNextStep(snapshot: AgentLoopStepUpdate): AgentLoopConfig {
    val nextReasoning = when (snapshot.thinkingLevel) {
        null -> this.reasoning
        ThinkingLevel.OFF -> null
        else -> dev.pi.ai.ThinkingLevel.fromWire(snapshot.thinkingLevel.wire)
    }
    return AgentLoopConfig(
        model = snapshot.model ?: this.model,
        reasoning = nextReasoning,
        streamOptions = this.streamOptions,
        toolExecution = this.toolExecution,
        convertToLlm = this.convertToLlm,
        transformContext = this.transformContext,
        getApiKey = this.getApiKey,
        shouldStopAfterStep = this.shouldStopAfterStep,
        prepareNextStep = this.prepareNextStep,
        getSteeringMessages = this.getSteeringMessages,
        getFollowUpMessages = this.getFollowUpMessages,
        beforeToolCall = this.beforeToolCall,
        afterToolCall = this.afterToolCall,
    )
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

private suspend fun streamAssistantResponse(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    streamFn: StreamFn,
): AssistantMessage {
    var messages: List<AgentMessage> = context.messages
    config.transformContext?.let { messages = it(messages) }

    val llmMessages = config.convertToLlm(messages)
    val llmContext = Context(
        systemPrompt = context.systemPrompt,
        messages = llmMessages,
        tools = context.tools,
    )

    val resolvedApiKey = (config.getApiKey?.invoke(config.model.provider)) ?: config.streamOptions.apiKey
    val options = config.streamOptions.copy(reasoning = config.reasoning, apiKey = resolvedApiKey)

    val response = streamFn(config.model, llmContext, options)

    var partial: AssistantMessage? = null
    var addedPartial = false

    response.collect().toList().let { events ->
        for (event in events) {
            when (event) {
                is AssistantMessageEvent.Start -> {
                    partial = event.partial
                    context.messages.add(event.partial)
                    addedPartial = true
                    emit.emit(AgentEvent.MessageStart(event.partial))
                }
                is AssistantMessageEvent.Done, is AssistantMessageEvent.Error -> {
                    val finalMessage = response.result()
                    if (addedPartial) {
                        context.messages[context.messages.size - 1] = finalMessage
                    } else {
                        context.messages.add(finalMessage)
                        emit.emit(AgentEvent.MessageStart(finalMessage))
                    }
                    emit.emit(AgentEvent.MessageEnd(finalMessage))
                    return finalMessage
                }
                else -> {
                    if (partial != null) {
                        partial = event.partial
                        context.messages[context.messages.size - 1] = event.partial
                        emit.emit(AgentEvent.MessageUpdate(event.partial, event))
                    }
                }
            }
        }
    }

    // Stream ended without an explicit terminal event.
    val finalMessage = response.result()
    if (addedPartial) {
        context.messages[context.messages.size - 1] = finalMessage
    } else {
        context.messages.add(finalMessage)
        emit.emit(AgentEvent.MessageStart(finalMessage))
    }
    emit.emit(AgentEvent.MessageEnd(finalMessage))
    return finalMessage
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

private data class ExecutedToolCallBatch(val messages: List<ToolResultMessage>, val terminate: Boolean)

private data class FinalizedToolCall(
    val toolCall: ToolCall,
    val result: AgentToolResult<Any?>,
    val isError: Boolean,
)

private sealed interface Preparation
private data class Prepared(val toolCall: ToolCall, val tool: AgentTool, val args: JsonObject) : Preparation
private data class Immediate(val result: AgentToolResult<Any?>, val isError: Boolean) : Preparation

private suspend fun executeToolCalls(
    context: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: List<ToolCall>,
    config: AgentLoopConfig,
    emit: AgentEventSink,
): ExecutedToolCallBatch {
    val hasSequential = toolCalls.any { tc ->
        context.tools?.find { it.name == tc.name }?.executionMode == ToolExecutionMode.SEQUENTIAL
    }
    return if (config.toolExecution == ToolExecutionMode.SEQUENTIAL || hasSequential) {
        executeSequential(context, assistantMessage, toolCalls, config, emit)
    } else {
        executeParallel(context, assistantMessage, toolCalls, config, emit)
    }
}

private suspend fun executeSequential(
    context: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: List<ToolCall>,
    config: AgentLoopConfig,
    emit: AgentEventSink,
): ExecutedToolCallBatch {
    val finalized = mutableListOf<FinalizedToolCall>()
    val messages = mutableListOf<ToolResultMessage>()

    for (toolCall in toolCalls) {
        emit.emit(AgentEvent.ToolExecutionStart(toolCall.id, toolCall.name, toolCall.arguments))
        val preparation = prepareToolCall(context, assistantMessage, toolCall, config)
        val fin = when (preparation) {
            is Immediate -> FinalizedToolCall(toolCall, preparation.result, preparation.isError)
            is Prepared -> {
                val executed = executePrepared(preparation, emit)
                finalizeExecuted(context, assistantMessage, preparation, executed, config)
            }
        }
        emitToolExecutionEnd(fin, emit)
        val msg = createToolResultMessage(fin)
        emitToolResultMessage(msg, emit)
        finalized.add(fin)
        messages.add(msg)
    }

    return ExecutedToolCallBatch(messages, shouldTerminate(finalized))
}

private suspend fun executeParallel(
    context: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: List<ToolCall>,
    config: AgentLoopConfig,
    emit: AgentEventSink,
): ExecutedToolCallBatch = coroutineScope {
    // Preflight sequentially (matches the TS: prepares run in source order,
    // immediates finalize inline, prepared ones run concurrently afterwards).
    val entries = ArrayList<suspend () -> FinalizedToolCall>(toolCalls.size)
    for (toolCall in toolCalls) {
        emit.emit(AgentEvent.ToolExecutionStart(toolCall.id, toolCall.name, toolCall.arguments))
        when (val preparation = prepareToolCall(context, assistantMessage, toolCall, config)) {
            is Immediate -> {
                val fin = FinalizedToolCall(toolCall, preparation.result, preparation.isError)
                emitToolExecutionEnd(fin, emit)
                entries.add { fin }
            }
            is Prepared -> entries.add {
                val executed = executePrepared(preparation, emit)
                val fin = finalizeExecuted(context, assistantMessage, preparation, executed, config)
                emitToolExecutionEnd(fin, emit)
                fin
            }
        }
    }

    val ordered = entries.map { async { it() } }.map { it.await() }
    val messages = mutableListOf<ToolResultMessage>()
    for (fin in ordered) {
        val msg = createToolResultMessage(fin)
        emitToolResultMessage(msg, emit)
        messages.add(msg)
    }
    ExecutedToolCallBatch(messages, shouldTerminate(ordered))
}

private fun shouldTerminate(finalized: List<FinalizedToolCall>): Boolean =
    finalized.isNotEmpty() && finalized.all { it.result.terminate == true }

private fun prepareArguments(tool: AgentTool, toolCall: ToolCall): ToolCall {
    val prepared = tool.prepareArguments(toolCall.arguments)
    return if (prepared == toolCall.arguments) toolCall else toolCall.copy(arguments = prepared)
}

private suspend fun prepareToolCall(
    context: AgentContext,
    assistantMessage: AssistantMessage,
    toolCall: ToolCall,
    config: AgentLoopConfig,
): Preparation {
    val tool = context.tools?.find { it.name == toolCall.name }
        ?: run {
            // Unknown tool: nudge the model with the valid tool names so it can
            // recover IN THIS TURN (pick a real tool, or just answer in words)
            // instead of giving up. The loop continues on an error result.
            val avail = context.tools?.joinToString(", ") { it.name } ?: "(none)"
            return Immediate(
                errorResult(
                    "No tool named '${toolCall.name}'. The only available tools are: $avail. " +
                        "If none fits, do NOT call a tool — just reason it out and answer in words.",
                ),
                true,
            )
        }

    return try {
        val preparedCall = prepareArguments(tool, toolCall)
        val validated = validateToolArguments(tool, preparedCall.arguments)
        config.beforeToolCall?.let { hook ->
            val before = hook(BeforeToolCallContext(assistantMessage, toolCall, validated, context))
            if (before?.block == true) {
                return Immediate(errorResult(before.reason ?: "Tool execution was blocked"), true)
            }
        }
        Prepared(toolCall, tool, validated)
    } catch (e: ToolValidationException) {
        Immediate(errorResult(e.message ?: "Validation failed"), true)
    } catch (e: CancellationException) {
        throw e // cancellation must unwind the loop, not become a tool "result"
    } catch (e: Exception) {
        Immediate(errorResult(e.message ?: e.toString()), true)
    }
}

private suspend fun executePrepared(prepared: Prepared, emit: AgentEventSink): Pair<AgentToolResult<Any?>, Boolean> {
    // Buffer partial-update events emitted from the (non-suspend) tool callback,
    // then flush them after execute() returns — mirroring the TS, which collects
    // update promises and awaits them with Promise.all before returning.
    val updates = mutableListOf<AgentToolResult<Any?>>()
    return try {
        val result = prepared.tool.execute(prepared.toolCall.id, prepared.args) { partial ->
            updates.add(partial)
        }
        for (partial in updates) {
            emit.emit(
                AgentEvent.ToolExecutionUpdate(
                    prepared.toolCall.id, prepared.toolCall.name, prepared.toolCall.arguments, partial,
                ),
            )
        }
        result to false
    } catch (e: CancellationException) {
        throw e // cancellation must unwind the loop, not become a tool "result"
    } catch (e: Exception) {
        for (partial in updates) {
            emit.emit(
                AgentEvent.ToolExecutionUpdate(
                    prepared.toolCall.id, prepared.toolCall.name, prepared.toolCall.arguments, partial,
                ),
            )
        }
        errorResult(e.message ?: e.toString()) to true
    }
}

private suspend fun finalizeExecuted(
    context: AgentContext,
    assistantMessage: AssistantMessage,
    prepared: Prepared,
    executed: Pair<AgentToolResult<Any?>, Boolean>,
    config: AgentLoopConfig,
): FinalizedToolCall {
    var result = executed.first
    var isError = executed.second

    config.afterToolCall?.let { hook ->
        try {
            val after = hook(
                AfterToolCallContext(assistantMessage, prepared.toolCall, prepared.args, result, isError, context),
            )
            if (after != null) {
                result = AgentToolResult(
                    content = after.content ?: result.content,
                    details = after.details ?: result.details,
                    terminate = after.terminate ?: result.terminate,
                )
                isError = after.isError ?: isError
            }
        } catch (e: CancellationException) {
            throw e // cancellation must unwind the loop, not become a tool "result"
        } catch (e: Exception) {
            result = errorResult(e.message ?: e.toString())
            isError = true
        }
    }

    return FinalizedToolCall(prepared.toolCall, result, isError)
}

private fun errorResult(message: String): AgentToolResult<Any?> =
    AgentToolResult(content = listOf(TextContent(message)), details = emptyMap<String, Any?>())

private suspend fun emitToolExecutionEnd(fin: FinalizedToolCall, emit: AgentEventSink) {
    emit.emit(AgentEvent.ToolExecutionEnd(fin.toolCall.id, fin.toolCall.name, fin.result, fin.isError))
}

private fun createToolResultMessage(fin: FinalizedToolCall): ToolResultMessage = ToolResultMessage(
    toolCallId = fin.toolCall.id,
    toolName = fin.toolCall.name,
    content = fin.result.content,
    details = fin.result.details,
    isError = fin.isError,
)

private suspend fun emitToolResultMessage(message: ToolResultMessage, emit: AgentEventSink) {
    emit.emit(AgentEvent.MessageStart(message))
    emit.emit(AgentEvent.MessageEnd(message))
}
