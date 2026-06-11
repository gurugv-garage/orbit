package dev.orbit.dock.agent

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory record of recent LLM turns. Surfaced by the dev panel's
 * "llm" tab. Lives in-process; not persisted.
 *
 * Each [TurnRecord] captures everything we know about one user→agent
 * round trip — input transcript, which model finally succeeded, every
 * model attempt that was tried (with per-attempt error if any), tool
 * calls fired, final reply text, and wall-clock latency.
 *
 * Token counts not yet wired — Koog doesn't expose usage stats from
 * agent.run() directly; we'd need to install a prompt-executor
 * interceptor. For now the panel just shows N/A.
 */
object TurnLog {

    private val _current = MutableStateFlow<TurnRecord?>(null)
    /** Last completed (or in-progress) turn. Null until first turn fires. */
    val current: StateFlow<TurnRecord?> = _current.asStateFlow()

    private var building: TurnRecord? = null

    // All mutation goes through this lock: tools execute concurrently (the
    // loop fired `move` + `set_face` 7ms apart in production), and an
    // unsynchronized add-while-snapshot threw ConcurrentModificationException
    // *into a tool result* the model then read. One lock, tiny critical
    // sections — contention is negligible at turn cadence.
    private val lock = Any()

    fun startTurn(transcript: String) = synchronized(lock) {
        building = TurnRecord(
            startMs = System.currentTimeMillis(),
            transcript = transcript,
        )
        _current.value = building
    }

    fun attemptModel(modelId: String, attempt: Int, total: Int) = synchronized(lock) {
        val b = building ?: return
        b.attempts.add(ModelTry(modelId = modelId, attempt = attempt, of = total))
        _current.value = b.snapshot()
    }

    fun attemptFailed(error: String) = synchronized(lock) {
        val b = building ?: return
        b.attempts.lastOrNull()?.error = error.take(200)
        _current.value = b.snapshot()
    }

    fun attemptSucceeded(modelId: String) = synchronized(lock) {
        val b = building ?: return
        b.attempts.lastOrNull()?.success = true
        b.winningModel = modelId
        _current.value = b.snapshot()
    }

    fun toolCalled(name: String, arg: String?) = synchronized(lock) {
        val b = building ?: return
        b.tools.add(ToolInvocation(
            name = name,
            arg = arg?.take(160),
            atMs = System.currentTimeMillis() - b.startMs,
        ))
        _current.value = b.snapshot()
    }

    fun endTurn(reply: String?) = synchronized(lock) {
        val b = building ?: return
        b.reply = reply?.take(500)
        b.endMs = System.currentTimeMillis()
        _current.value = b.snapshot()
        // Keep building around so post-turn tool calls (rare) still record
        // until next turn starts.
    }
}

/**
 * Snapshot of a single user→agent turn. Mutable while building, but
 * we always emit a copy via [snapshot] so subscribers see immutable
 * values.
 */
data class TurnRecord(
    val startMs: Long = System.currentTimeMillis(),
    var endMs: Long? = null,
    val transcript: String = "",
    var winningModel: String? = null,
    var reply: String? = null,
    val attempts: MutableList<ModelTry> = mutableListOf(),
    val tools: MutableList<ToolInvocation> = mutableListOf(),
    // Monotonic version stamp so StateFlow always treats the next
    // snapshot as a new value even if some other field happens to
    // match (Compose data-class equality is structural).
    val version: Long = 0L,
) {
    val latencyMs: Long? get() = endMs?.let { it - startMs }

    fun snapshot(): TurnRecord = copy(
        attempts = attempts.map { it.copy() }.toMutableList(),
        tools = tools.map { it.copy() }.toMutableList(),
        version = version + 1,
    )
}

data class ModelTry(
    val modelId: String,
    val attempt: Int,
    val of: Int,
    var success: Boolean = false,
    var error: String? = null,
)

data class ToolInvocation(
    val name: String,
    val arg: String? = null,
    val atMs: Long = 0L,
)
