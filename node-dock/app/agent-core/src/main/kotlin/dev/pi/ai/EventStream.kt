package dev.pi.ai

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/**
 * Port of pi-ai's `EventStream<T, R>` (utils/event-stream.ts).
 *
 * A push-based async stream: producers call [push] for each event and [end] to
 * close it; consumers iterate via [collect] and await the terminal value via
 * [result]. When a "complete" event is pushed, the final result is resolved
 * from it. This mirrors the JS contract where `result()` resolves from the
 * `done`/`error` event rather than from stream closure.
 */
open class EventStream<T : Any, R : Any>(
    private val isComplete: (T) -> Boolean,
    private val extractResult: (T) -> R,
) {
    // Unlimited buffer so push() never suspends, matching the JS queue.
    private val channel = Channel<T>(Channel.UNLIMITED)
    private val finalResult = CompletableDeferred<R>()

    @Volatile
    private var done = false

    /** Enqueue an event. No-op after the stream is done. */
    fun push(event: T) {
        if (done) return
        if (isComplete(event)) {
            done = true
            finalResult.complete(extractResult(event))
        }
        channel.trySend(event)
        if (done) channel.close()
    }

    /** Close the stream, optionally supplying the terminal result. */
    fun end(result: R? = null) {
        done = true
        if (result != null) finalResult.complete(result)
        channel.close()
    }

    /** Consume events in order until the stream closes. */
    fun collect(): Flow<T> = flow {
        for (event in channel) {
            emit(event)
        }
    }

    /** Await the terminal result. */
    suspend fun result(): R = finalResult.await()
}

/** Specialized stream carrying the assistant streaming protocol. */
class AssistantMessageEventStream :
    EventStream<AssistantMessageEvent, AssistantMessage>(
        isComplete = { it is AssistantMessageEvent.Done || it is AssistantMessageEvent.Error },
        extractResult = {
            when (it) {
                is AssistantMessageEvent.Done -> it.message
                is AssistantMessageEvent.Error -> it.error
                else -> throw IllegalStateException("Unexpected event type for final result")
            }
        },
    )

/**
 * Event protocol emitted by an [AssistantMessageEventStream].
 *
 * Streams emit [Start], then any number of partial-update events, then
 * terminate with [Done] (success) or [Error] (failure). Each carries the
 * running [partial] assistant message so consumers can render incremental UI.
 */
sealed interface AssistantMessageEvent {
    val partial: AssistantMessage

    data class Start(override val partial: AssistantMessage) : AssistantMessageEvent

    data class TextStart(val contentIndex: Int, override val partial: AssistantMessage) : AssistantMessageEvent
    data class TextDelta(val contentIndex: Int, val delta: String, override val partial: AssistantMessage) :
        AssistantMessageEvent
    data class TextEnd(val contentIndex: Int, val content: String, override val partial: AssistantMessage) :
        AssistantMessageEvent

    data class ThinkingStart(val contentIndex: Int, override val partial: AssistantMessage) : AssistantMessageEvent
    data class ThinkingDelta(val contentIndex: Int, val delta: String, override val partial: AssistantMessage) :
        AssistantMessageEvent
    data class ThinkingEnd(val contentIndex: Int, val content: String, override val partial: AssistantMessage) :
        AssistantMessageEvent

    data class ToolCallStart(val contentIndex: Int, override val partial: AssistantMessage) : AssistantMessageEvent
    data class ToolCallDelta(val contentIndex: Int, val delta: String, override val partial: AssistantMessage) :
        AssistantMessageEvent
    data class ToolCallEnd(val contentIndex: Int, val toolCall: ToolCall, override val partial: AssistantMessage) :
        AssistantMessageEvent

    /** Terminal success. `reason` is one of stop/length/toolUse. */
    data class Done(val reason: StopReason, val message: AssistantMessage) : AssistantMessageEvent {
        override val partial: AssistantMessage get() = message
    }

    /** Terminal failure. `reason` is error/aborted. */
    data class Error(val reason: StopReason, val error: AssistantMessage) : AssistantMessageEvent {
        override val partial: AssistantMessage get() = error
    }
}
