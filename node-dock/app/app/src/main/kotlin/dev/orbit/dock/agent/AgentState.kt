package dev.orbit.dock.agent

/**
 * Observable agent lifecycle state. Surfaced to the UI so the user always
 * knows what's happening even when no spoken text is visible.
 */
sealed class AgentState {
    object Idle : AgentState()

    /** POST sent, no bytes back yet — connection + prompt-eval latency. The
     *  dock is reaching the model but the model hasn't produced anything. */
    data class Waiting(val model: String) : AgentState()

    /** The model is emitting reasoning/thinking tokens (the preamble a thinking
     *  model like glm produces before the answer). First real sign of life. */
    data class Thinking(val model: String, val attempt: Int = 1, val of: Int = 1) : AgentState()

    /** Agent is executing a tool call. */
    data class ToolCalling(val name: String) : AgentState()

    /** TTS is producing audio (first reply sentence streamed out). */
    object Speaking : AgentState()

    /** All models failed (or another non-recoverable error). */
    data class Failed(val message: String) : AgentState()

    val shortLabel: String
        get() = when (this) {
            is Idle -> "idle"
            is Waiting -> "waiting · ${model.substringAfter('/').substringBefore(':')}"
            is Thinking -> "thinking · ${model.substringAfter('/').substringBefore(':')} (${attempt}/${of})"
            is ToolCalling -> "tool · $name"
            is Speaking -> "speaking"
            is Failed -> "error · $message"
        }
}
