package dev.pi.agent

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.ImageContent
import dev.pi.ai.Message
import dev.pi.ai.Model
import dev.pi.ai.SimpleStreamOptions
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.UserMessage
import dev.pi.ai.Usage

/**
 * Kotlin port of pi-agent-core `src/agent.ts`.
 *
 * Stateful wrapper around the low-level [runAgentLoop]. Owns the transcript,
 * emits lifecycle events to subscribers, executes tools, and exposes steering /
 * follow-up queues. Mirrors the TS public surface (`prompt`, `continue`,
 * `subscribe`, `abort`, `reset`, queue APIs, `state`).
 *
 * Concurrency: `prompt`/`continue` are `suspend` and run the loop to completion
 * on the caller's coroutine (the TS returns a promise the caller awaits). A
 * single run is active at a time; starting another throws.
 */

/** Mutable public agent state. */
class AgentState internal constructor(
    var systemPrompt: String,
    var model: Model,
    var thinkingLevel: ThinkingLevel,
    tools: List<AgentTool>,
    messages: List<AgentMessage>,
) {
    /** Available tools. Assigning copies the top-level list. */
    var tools: List<AgentTool> = tools.toList()
        set(value) { field = value.toList() }

    /** Conversation transcript. Assigning copies the top-level list. */
    var messages: MutableList<AgentMessage> = messages.toMutableList()
        set(value) { field = value.toMutableList() }

    var isStreaming: Boolean = false
        internal set
    var streamingMessage: AgentMessage? = null
        internal set
    var pendingToolCalls: Set<String> = emptySet()
        internal set
    var errorMessage: String? = null
        internal set
}

/** Listener for agent lifecycle events. */
fun interface AgentListener {
    suspend fun onEvent(event: AgentEvent)
}

data class AgentOptions(
    val systemPrompt: String = "",
    val model: Model = Model.UNKNOWN,
    val thinkingLevel: ThinkingLevel = ThinkingLevel.OFF,
    val tools: List<AgentTool> = emptyList(),
    val initialMessages: List<AgentMessage> = emptyList(),
    val convertToLlm: (suspend (List<AgentMessage>) -> List<Message>)? = null,
    val transformContext: (suspend (List<AgentMessage>) -> List<AgentMessage>)? = null,
    val streamFn: StreamFn? = null,
    val getApiKey: (suspend (provider: String) -> String?)? = null,
    val beforeToolCall: (suspend (BeforeToolCallContext) -> BeforeToolCallResult?)? = null,
    val afterToolCall: (suspend (AfterToolCallContext) -> AfterToolCallResult?)? = null,
    val prepareNextTurn: (suspend () -> AgentLoopTurnUpdate?)? = null,
    val steeringMode: QueueMode = QueueMode.ONE_AT_A_TIME,
    val followUpMode: QueueMode = QueueMode.ONE_AT_A_TIME,
    val sessionId: String? = null,
    val toolExecution: ToolExecutionMode = ToolExecutionMode.PARALLEL,
)

private class PendingMessageQueue(var mode: QueueMode) {
    private val messages = ArrayDeque<AgentMessage>()
    fun enqueue(message: AgentMessage) { messages.addLast(message) }
    fun hasItems(): Boolean = messages.isNotEmpty()
    fun drain(): List<AgentMessage> = when (mode) {
        QueueMode.ALL -> messages.toList().also { messages.clear() }
        QueueMode.ONE_AT_A_TIME -> if (messages.isEmpty()) emptyList() else listOf(messages.removeFirst())
    }
    fun clear() = messages.clear()
}

class AgentBusyException(message: String) : RuntimeException(message)

class Agent(private val options: AgentOptions = AgentOptions()) {
    val state: AgentState = AgentState(
        systemPrompt = options.systemPrompt,
        model = options.model,
        thinkingLevel = options.thinkingLevel,
        tools = options.tools,
        messages = options.initialMessages,
    )

    private val listeners = LinkedHashSet<AgentListener>()
    private val steeringQueue = PendingMessageQueue(options.steeringMode)
    private val followUpQueue = PendingMessageQueue(options.followUpMode)

    var convertToLlm: suspend (List<AgentMessage>) -> List<Message> =
        options.convertToLlm ?: ::defaultConvertToLlm
    var transformContext: (suspend (List<AgentMessage>) -> List<AgentMessage>)? = options.transformContext
    var streamFn: StreamFn = options.streamFn ?: error("Agent requires a streamFn (no default provider in the port)")
    var getApiKey: (suspend (provider: String) -> String?)? = options.getApiKey
    var beforeToolCall = options.beforeToolCall
    var afterToolCall = options.afterToolCall
    var prepareNextTurn = options.prepareNextTurn
    var sessionId: String? = options.sessionId
    var toolExecution: ToolExecutionMode = options.toolExecution

    private var activeRun = false

    /** Subscribe to lifecycle events. Returns an unsubscribe handle. */
    fun subscribe(listener: AgentListener): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    var steeringMode: QueueMode
        get() = steeringQueue.mode
        set(value) { steeringQueue.mode = value }

    var followUpMode: QueueMode
        get() = followUpQueue.mode
        set(value) { followUpQueue.mode = value }

    fun steer(message: AgentMessage) = steeringQueue.enqueue(message)
    fun followUp(message: AgentMessage) = followUpQueue.enqueue(message)
    fun clearSteeringQueue() = steeringQueue.clear()
    fun clearFollowUpQueue() = followUpQueue.clear()
    fun clearAllQueues() { clearSteeringQueue(); clearFollowUpQueue() }
    fun hasQueuedMessages(): Boolean = steeringQueue.hasItems() || followUpQueue.hasItems()

    /** Clear transcript, runtime state, and queued messages. */
    fun reset() {
        state.messages = mutableListOf()
        state.isStreaming = false
        state.streamingMessage = null
        state.pendingToolCalls = emptySet()
        state.errorMessage = null
        clearAllQueues()
    }

    /** Start a new prompt from text. */
    suspend fun prompt(input: String, images: List<ImageContent> = emptyList()) {
        if (activeRun) throw AgentBusyException(
            "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait.",
        )
        val content = buildList<dev.pi.ai.Content> {
            add(TextContent(input))
            addAll(images)
        }
        runPromptMessages(listOf(UserMessage(content)))
    }

    /** Start a new prompt from explicit messages. */
    suspend fun prompt(messages: List<AgentMessage>) {
        if (activeRun) throw AgentBusyException("Agent is already processing a prompt.")
        runPromptMessages(messages)
    }

    /** Continue from the current transcript. Last message must be user or tool-result. */
    suspend fun continueRun() {
        if (activeRun) throw AgentBusyException("Agent is already processing. Wait before continuing.")
        val last = state.messages.lastOrNull() ?: throw IllegalStateException("No messages to continue from")
        if (last.role == "assistant") {
            val queuedSteering = steeringQueue.drain()
            if (queuedSteering.isNotEmpty()) {
                runPromptMessages(queuedSteering, skipInitialSteeringPoll = true)
                return
            }
            val queuedFollowUps = followUpQueue.drain()
            if (queuedFollowUps.isNotEmpty()) {
                runPromptMessages(queuedFollowUps)
                return
            }
            throw IllegalStateException("Cannot continue from message role: assistant")
        }
        runWithLifecycle {
            runAgentLoopContinue(createContextSnapshot(), createLoopConfig(), ::processEvents, streamFn)
        }
    }

    private suspend fun runPromptMessages(messages: List<AgentMessage>, skipInitialSteeringPoll: Boolean = false) {
        runWithLifecycle {
            runAgentLoop(
                messages,
                createContextSnapshot(),
                createLoopConfig(skipInitialSteeringPoll),
                ::processEvents,
                streamFn,
            )
        }
    }

    private fun createContextSnapshot(): AgentContext = AgentContext(
        systemPrompt = state.systemPrompt,
        messages = state.messages.toMutableList(),
        tools = state.tools.toList(),
    )

    private fun createLoopConfig(skipInitialSteeringPoll: Boolean = false): AgentLoopConfig {
        var skip = skipInitialSteeringPoll
        val prepareHook: (suspend (ShouldStopAfterTurnContext) -> AgentLoopTurnUpdate?)? =
            prepareNextTurn?.let { hook -> { _ -> hook() } }
        return AgentLoopConfig(
            model = state.model,
            reasoning = if (state.thinkingLevel == ThinkingLevel.OFF) null
                else dev.pi.ai.ThinkingLevel.fromWire(state.thinkingLevel.wire),
            streamOptions = SimpleStreamOptions(sessionId = sessionId),
            toolExecution = toolExecution,
            convertToLlm = convertToLlm,
            transformContext = transformContext,
            getApiKey = getApiKey,
            beforeToolCall = beforeToolCall,
            afterToolCall = afterToolCall,
            prepareNextTurn = prepareHook,
            getSteeringMessages = {
                if (skip) { skip = false; emptyList() } else steeringQueue.drain()
            },
            getFollowUpMessages = { followUpQueue.drain() },
        )
    }

    private suspend fun runWithLifecycle(executor: suspend () -> Unit) {
        if (activeRun) throw AgentBusyException("Agent is already processing.")
        activeRun = true
        state.isStreaming = true
        state.streamingMessage = null
        state.errorMessage = null
        try {
            executor()
        } catch (e: Throwable) {
            handleRunFailure(e)
        } finally {
            finishRun()
        }
    }

    private suspend fun handleRunFailure(error: Throwable) {
        val failure = AssistantMessage(
            content = listOf(TextContent("")),
            api = state.model.api,
            provider = state.model.provider,
            model = state.model.id,
            usage = Usage.EMPTY,
            stopReason = dev.pi.ai.StopReason.ERROR,
            errorMessage = error.message ?: error.toString(),
        )
        processEvents(AgentEvent.MessageStart(failure))
        processEvents(AgentEvent.MessageEnd(failure))
        processEvents(AgentEvent.TurnEnd(failure, emptyList()))
        processEvents(AgentEvent.AgentEnd(listOf(failure)))
    }

    private fun finishRun() {
        state.isStreaming = false
        state.streamingMessage = null
        state.pendingToolCalls = emptySet()
        activeRun = false
    }

    private suspend fun processEvents(event: AgentEvent) {
        when (event) {
            is AgentEvent.MessageStart -> state.streamingMessage = event.message
            is AgentEvent.MessageUpdate -> state.streamingMessage = event.message
            is AgentEvent.MessageEnd -> {
                state.streamingMessage = null
                state.messages.add(event.message)
            }
            is AgentEvent.ToolExecutionStart ->
                state.pendingToolCalls = state.pendingToolCalls + event.toolCallId
            is AgentEvent.ToolExecutionEnd ->
                state.pendingToolCalls = state.pendingToolCalls - event.toolCallId
            is AgentEvent.TurnEnd -> {
                val m = event.message
                if (m is AssistantMessage && m.errorMessage != null) state.errorMessage = m.errorMessage
            }
            is AgentEvent.AgentEnd -> state.streamingMessage = null
            else -> {}
        }
        for (listener in listeners.toList()) listener.onEvent(event)
    }
}

/** Default convertToLlm: keep only LLM messages (drop custom transcript entries). */
fun defaultConvertToLlm(messages: List<AgentMessage>): List<Message> =
    messages.filterIsInstance<Message>()
