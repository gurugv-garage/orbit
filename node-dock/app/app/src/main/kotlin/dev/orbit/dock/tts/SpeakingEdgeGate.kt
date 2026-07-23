package dev.orbit.dock.tts

/**
 * Decides when the dock's "speaking" signal rises and falls.
 *
 * The naive rule — "speaking=false whenever the TTS queue is empty" — fired in
 * the GAP between streamed sentences (TTS finishes sentence N before the LLM
 * emits sentence N+1). That false edge mid-reply flickered the face, consumed
 * [dev.orbit.dock.perception.AutoRelisten]'s one re-arm, and beeped the mic
 * open in the middle of the dock's own reply.
 *
 * Rule here: while a TURN is open, the queue draining is NOT the end of
 * speech — more sentences may still stream in. The falling edge fires only
 * when the queue is drained AND the turn has closed (or no turn was open,
 * e.g. a standalone system line), or on an explicit stop.
 *
 * Pure + synchronized so it's unit-testable ([SpeakingEdgeGateTest]) and safe
 * across the TTS engine thread / agent thread.
 */
class SpeakingEdgeGate {

    /** Optional observability tap: invoked (under the gate's lock — keep it
     *  cheap) whenever the public speaking signal actually rises/falls. The
     *  gate stays dependency-free; the app wires this where it's constructed. */
    var onEdge: ((rising: Boolean) -> Unit)? = null

    private var turnOpen = false
    private var speaking = false   // the signaled (public) speaking state

    /** A turn began (more sentences may stream in until it closes). */
    @Synchronized
    fun onTurnOpened() {
        turnOpen = true
    }

    /**
     * The turn's LLM loop finished — no more sentences will be enqueued.
     * @param queueDrained nothing is playing or pending right now.
     * @return true → signal the falling edge (speech is truly over).
     */
    @Synchronized
    fun onTurnClosed(queueDrained: Boolean): Boolean {
        turnOpen = false
        return fall(queueDrained)
    }

    /** An utterance actually started playing. @return true → rising edge. */
    @Synchronized
    fun onUtteranceStarted(): Boolean {
        val rise = !speaking
        speaking = true
        if (rise) onEdge?.invoke(true)
        return rise
    }

    /**
     * An utterance finished (done/error/stopped) and nothing else is queued.
     * @return true → falling edge (only once the turn is closed too).
     */
    @Synchronized
    fun onQueueDrained(): Boolean = fall(queueDrained = true)

    /** Hard stop (barge-in / tap-stop): always ends speech NOW, mid-turn or
     *  not. @return true → falling edge to signal. */
    @Synchronized
    fun onStopped(): Boolean {
        val fall = speaking
        speaking = false
        if (fall) onEdge?.invoke(false)
        return fall
    }

    private fun fall(queueDrained: Boolean): Boolean {
        if (!speaking || !queueDrained || turnOpen) return false
        speaking = false
        onEdge?.invoke(false)
        return true
    }
}
