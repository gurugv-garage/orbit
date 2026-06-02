package dev.orbit.dock.body

/**
 * Brain-owned intent for the body. Replaces the old body→brain state stream.
 *
 * The brain knows what it last asked for; the body is per-part idempotent so
 * we don't need it to tell us what state it's in. UIs that want an animated
 * progress bar can compute it locally off `sentAt + durationMs`.
 */
data class BodyIntent(
    val parts: Map<String, PartIntent> = emptyMap(),
) {
    companion object {
        val EMPTY = BodyIntent()
    }
}

data class PartIntent(
    /** Catalog state name if this intent was issued via setState; null for raw setTarget. */
    val stateName: String?,
    /** Raw params last commanded (post-clamp). */
    val params: Map<String, Double>,
    /** Brain wall-clock when we sent the command (System.currentTimeMillis). */
    val sentAt: Long,
    /** Expected motion duration. 0 = snap. */
    val durationMs: Int,
    /** Where this part is in the request/response/motion lifecycle. */
    val phase: Phase = Phase.Waiting,
) {
    /** Phase per DESIGN.md §3.2: brain-side UI state machine. */
    enum class Phase { Waiting, Moving, Settled, NoAck, Rejected }

    /** Linear progress 0..1 for UI animation. Returns 1 when settled. */
    fun progressAt(now: Long): Float =
        if (durationMs <= 0) 1f
        else ((now - sentAt).toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)

    val settled: Boolean
        get() = durationMs <= 0 || System.currentTimeMillis() - sentAt >= durationMs
}

/** Async non-fatal notices delivered on the events flow. */
sealed interface BodyEvent {
    data object Boot : BodyEvent

    /** Body clipped a param value to its declared range. */
    data class Clipped(
        val part: String,
        val param: String,
        val requested: Double,
        val applied: Double,
    ) : BodyEvent

    /** Same shape as Clipped; surfaced separately because the body emits an
     *  `error: OUT_OF_RANGE` alongside the `event: clipped`. We expose both
     *  so tools can match against either. */
    data class OutOfRange(
        val part: String,
        val param: String,
        val requested: Double,
        val applied: Double,
    ) : BodyEvent

    data class UnknownPart(val requested: String) : BodyEvent
    data class UnknownParam(val part: String, val param: String) : BodyEvent
    data class Stall(val part: String) : BodyEvent
    data class Estop(val source: String) : BodyEvent

    /** Strict-mode protocol drift detected (see DESIGN.md §5.4). */
    data class ProtocolDrift(val detail: String) : BodyEvent
}
