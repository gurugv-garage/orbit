package dev.orbit.dock.tts

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The speaking signal's edge rules (see [SpeakingEdgeGate]):
 *  - rises on the first utterance of a run, once;
 *  - does NOT fall in the gap between streamed sentences while the turn is open
 *    (the bug that re-armed the mic mid-reply and flickered the face);
 *  - falls exactly once when the queue drains after the turn closed;
 *  - a hard stop always fells it immediately, even mid-turn.
 */
class SpeakingEdgeGateTest {

    @Test
    fun `rises once per speech run`() {
        val g = SpeakingEdgeGate()
        g.onTurnOpened()
        assertThat(g.onUtteranceStarted()).isTrue()    // first sentence → rise
        assertThat(g.onUtteranceStarted()).isFalse()   // second sentence → no edge
    }

    @Test
    fun `gap between streamed sentences does not fall mid-turn`() {
        val g = SpeakingEdgeGate()
        g.onTurnOpened()
        g.onUtteranceStarted()
        // sentence 1 finished, queue empty, but the LLM is still streaming
        assertThat(g.onQueueDrained()).isFalse()
        // sentence 2 arrives and plays — still no rising edge (run continues)
        assertThat(g.onUtteranceStarted()).isFalse()
        // turn closes while sentence 2 still playing → no fall yet
        assertThat(g.onTurnClosed(queueDrained = false)).isFalse()
        // sentence 2 done, queue drained, turn closed → the one falling edge
        assertThat(g.onQueueDrained()).isTrue()
        // idempotent — no double fall
        assertThat(g.onQueueDrained()).isFalse()
    }

    @Test
    fun `turn closing with an already-drained queue falls immediately`() {
        val g = SpeakingEdgeGate()
        g.onTurnOpened()
        g.onUtteranceStarted()
        g.onQueueDrained()                              // mid-turn → held
        assertThat(g.onTurnClosed(queueDrained = true)).isTrue()
    }

    @Test
    fun `turn that never spoke closes without an edge`() {
        val g = SpeakingEdgeGate()
        g.onTurnOpened()
        assertThat(g.onTurnClosed(queueDrained = true)).isFalse()
    }

    @Test
    fun `hard stop falls immediately even mid-turn`() {
        val g = SpeakingEdgeGate()
        g.onTurnOpened()
        g.onUtteranceStarted()
        assertThat(g.onStopped()).isTrue()
        assertThat(g.onStopped()).isFalse()             // no double fall
        // the turn's own close after the stop is a no-op
        assertThat(g.onTurnClosed(queueDrained = true)).isFalse()
    }

    @Test
    fun `speech outside any turn rises and falls on its own`() {
        val g = SpeakingEdgeGate()
        // e.g. the "not configured" system line — no turn open
        assertThat(g.onUtteranceStarted()).isTrue()
        assertThat(g.onQueueDrained()).isTrue()
    }

    @Test
    fun `next turn after a stop works normally`() {
        val g = SpeakingEdgeGate()
        g.onTurnOpened()
        g.onUtteranceStarted()
        g.onStopped()
        g.onTurnClosed(queueDrained = true)

        g.onTurnOpened()
        assertThat(g.onUtteranceStarted()).isTrue()
        assertThat(g.onTurnClosed(queueDrained = true)).isTrue()
    }
}
