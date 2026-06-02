package dev.pi.ai

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Stream function used by the agent loop, mirroring pi-ai's `streamSimple`.
 *
 * Contract (from types.ts): must not throw for request/model/runtime failures.
 * Failures are encoded in the returned stream as an [AssistantMessageEvent.Error]
 * plus a final [AssistantMessage] with stopReason error/aborted.
 */
typealias StreamFn = (
    model: Model,
    context: Context,
    options: SimpleStreamOptions?,
) -> AssistantMessageEventStream

/**
 * Faux transport for offline tests — the Kotlin analogue of pi-ai's
 * `providers/faux.ts`. You script the assistant responses; the loop drives them
 * exactly as if a real provider had streamed them.
 *
 * Each call to the returned [StreamFn] consumes the next scripted response.
 * Responses can be a plain final message or a list of streaming events.
 */
class FauxTransport(
    private val scope: CoroutineScope,
    responses: List<FauxResponse>,
) {
    private val queue = ArrayDeque(responses)

    /** A scripted turn: either a complete message or an explicit event sequence. */
    sealed interface FauxResponse {
        /** Emit start -> done with this final message. */
        data class Final(val message: AssistantMessage) : FauxResponse

        /** Emit exactly these events (must terminate with Done/Error). */
        data class Events(val events: List<AssistantMessageEvent>) : FauxResponse
    }

    val streamFn: StreamFn = { model, _, _ ->
        val stream = AssistantMessageEventStream()
        val response = if (queue.isEmpty()) {
            FauxResponse.Final(
                AssistantMessage(
                    content = listOf(TextContent("[faux] no scripted response")),
                    api = model.api,
                    provider = model.provider,
                    model = model.id,
                    usage = Usage.EMPTY,
                    stopReason = StopReason.STOP,
                ),
            )
        } else {
            queue.removeFirst()
        }
        scope.launch {
            when (response) {
                is FauxResponse.Final -> {
                    stream.push(AssistantMessageEvent.Start(response.message))
                    stream.push(AssistantMessageEvent.Done(StopReason.STOP, response.message))
                }
                is FauxResponse.Events -> response.events.forEach { stream.push(it) }
            }
        }
        stream
    }

    companion object {
        /** Convenience: a single assistant text reply. */
        fun text(
            scope: CoroutineScope,
            text: String,
            model: Model = Model.UNKNOWN,
        ): FauxTransport = FauxTransport(
            scope,
            listOf(
                FauxResponse.Final(
                    AssistantMessage(
                        content = listOf(TextContent(text)),
                        api = model.api,
                        provider = model.provider,
                        model = model.id,
                        usage = Usage.EMPTY,
                        stopReason = StopReason.STOP,
                    ),
                ),
            ),
        )
    }
}

/** Helper to build an assistant message that requests a single tool call. */
fun assistantToolCall(
    callId: String,
    toolName: String,
    arguments: kotlinx.serialization.json.JsonObject,
    model: Model = Model.UNKNOWN,
): AssistantMessage = AssistantMessage(
    content = listOf(ToolCall(id = callId, name = toolName, arguments = arguments)),
    api = model.api,
    provider = model.provider,
    model = model.id,
    usage = Usage.EMPTY,
    stopReason = StopReason.TOOL_USE,
)
