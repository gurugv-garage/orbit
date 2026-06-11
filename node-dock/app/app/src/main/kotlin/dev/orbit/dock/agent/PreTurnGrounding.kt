package dev.orbit.dock.agent

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Synchronizes "who am I talking to" with the start of a turn.
 *
 * The dock fires a recognition request the moment STT arms (the user is about
 * to speak, facing the dock) so recognition runs IN PARALLEL with their speech.
 * Before, that request was fire-and-forget: if it lost the race against the
 * final transcript, the turn's prompt was grounded with a stale (possibly
 * wrong) identity — the exact "it doesn't know who it's talking to" failure.
 *
 * Now the turn start awaits the in-flight recognition, BOUNDED by [maxWaitMs]:
 * in the normal case the user talks for seconds while recognition takes a few
 * hundred ms, so the wait is zero; in the worst case the turn starts at most
 * [maxWaitMs] late with the previous grounding (better slightly late than
 * wrongly named).
 *
 * Pure (no Android) → unit-tested in [PreTurnGroundingTest].
 */
class PreTurnGrounding(private val maxWaitMs: Long = 800) {

    @Volatile private var pending: CompletableDeferred<Unit>? = null

    /**
     * A listening session armed and a recognition request was just sent.
     * Any prior pending request is superseded.
     */
    fun begin() {
        pending?.complete(Unit)
        pending = CompletableDeferred()
    }

    /** The recognition result landed (the snapshot cache is already updated). */
    fun complete() {
        pending?.complete(Unit)
    }

    /** Nothing will answer (no link / no face at arm time) — don't make the
     *  next turn wait. */
    fun cancel() {
        pending?.complete(Unit)
        pending = null
    }

    /**
     * Gate a turn start on the in-flight recognition, if any. Returns
     * immediately when nothing is pending or it already completed; waits at
     * most [maxWaitMs] otherwise. One-shot: the pending slot is consumed.
     */
    suspend fun awaitGrounded() {
        val p = pending ?: return
        withTimeoutOrNull(maxWaitMs) { p.await() }
        // consume the slot only after waiting, so a result landing mid-wait
        // still finds (and completes) this deferred via [complete].
        if (pending === p) pending = null
    }
}
