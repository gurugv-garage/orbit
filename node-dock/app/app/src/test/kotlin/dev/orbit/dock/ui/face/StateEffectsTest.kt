package dev.orbit.dock.ui.face

import androidx.compose.ui.graphics.ColorMatrix
import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The disconnect fade's COLOUR MATH, unit-tested.
 *
 * Why this exists rather than a screenshot: verifying the fade live means taking
 * the station down — and the screenshot harness rides the station, so the dock
 * goes blind at the exact moment there'd be something to see. This pins the one
 * thing that could silently be wrong (the matrix), the same way the sweat bead
 * SHOULD have been checked before it shipped as a tear.
 *
 * The rendering itself (graphicsLayer + saveLayer) is still only verified by
 * eye — see face-harness.md. Colour math is testable; "does it read as broken
 * rather than sulking" is not.
 */
class StateEffectsTest {

    /** Connected → full colour: the matrix must be identity, or a healthy dock
     *  is quietly tinted forever. */
    @Test
    fun connectedIsFullSaturation() {
        val m = ColorMatrix().apply { setToSaturation(1f) }
        val identity = ColorMatrix()
        for (i in 0 until 20) {
            assertThat(m.values[i]).isWithin(0.001f).of(identity.values[i])
        }
    }

    /**
     * Disconnected → greyscale. Every RGB output row collapses to the same
     * luminance weights, which is what "drained of colour" IS.
     */
    @Test
    fun disconnectedIsGreyscale() {
        val m = ColorMatrix().apply { setToSaturation(0f) }
        // Row 0 (R out) and row 1 (G out) must agree on every input channel.
        assertThat(m[0, 0]).isWithin(0.001f).of(m[1, 0])
        assertThat(m[0, 1]).isWithin(0.001f).of(m[1, 1])
        assertThat(m[0, 2]).isWithin(0.001f).of(m[1, 2])
        // …and they're luminance weights, not zeros (a black screen is NOT the
        // effect — the face must stay legible, just colourless).
        assertThat(m[0, 0] + m[0, 1] + m[0, 2]).isWithin(0.01f).of(1f)
    }

    /** A reconnect blip shows PARTIAL desaturation — honest, not alarming. The
     *  effect is a state settling into view, not a strobe. */
    @Test
    fun partialSaturationIsBetweenTheTwo() {
        val half = ColorMatrix().apply { setToSaturation(0.5f) }
        val full = ColorMatrix().apply { setToSaturation(1f) }
        val none = ColorMatrix().apply { setToSaturation(0f) }
        // The red-from-red term sits strictly between grey and full colour.
        assertThat(half[0, 0]).isGreaterThan(none[0, 0])
        assertThat(half[0, 0]).isLessThan(full[0, 0])
    }
}
