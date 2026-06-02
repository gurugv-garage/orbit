package dev.orbit.dock.perception

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class MicHelpersTest {

    @Test
    fun rmsOfSilenceIsZero() {
        val silence = ShortArray(512)
        assertThat(silence.rmsLevel()).isWithin(0.0001f).of(0f)
    }

    @Test
    fun rmsOfFullScaleIsOne() {
        val full = ShortArray(512) { Short.MAX_VALUE }
        // Constant Short.MAX_VALUE — RMS normalized to ±1 → 1.0
        assertThat(full.rmsLevel()).isWithin(0.001f).of(1f)
    }

    @Test
    fun rmsOfHalfAmplitudeIsAboutHalf() {
        val half = ShortArray(512) { (Short.MAX_VALUE / 2).toShort() }
        assertThat(half.rmsLevel()).isWithin(0.01f).of(0.5f)
    }

    @Test
    fun toFloat32MapsRange() {
        val pcm = shortArrayOf(0, Short.MAX_VALUE, (Short.MIN_VALUE + 1).toShort())
        val f = pcm.toFloat32()
        assertThat(f[0]).isWithin(0.001f).of(0f)
        assertThat(f[1]).isWithin(0.001f).of(0.99997f) // MAX_VALUE / 32768
        assertThat(f[2]).isWithin(0.01f).of(-1f)
    }
}
