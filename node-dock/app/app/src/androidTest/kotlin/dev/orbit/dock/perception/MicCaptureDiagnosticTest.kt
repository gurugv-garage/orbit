package dev.orbit.dock.perception

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.absoluteValue
import kotlin.math.sqrt

/**
 * Diagnostic: does the AVD's mic actually deliver audio bytes to the app?
 *
 * Captures ~15 frames (~480 ms at 16 kHz). Reports peak amplitude and RMS.
 * Pass/fail criteria are *informational* — the test always passes,
 * but the log shows whether the stream contains signal or pure silence.
 *
 * Run on a configured AVD:
 *   1. Extended Controls → Microphone → Enable Host Microphone Access = ON
 *   2. macOS Privacy & Security → Microphone → Android Studio granted
 *
 * Expected behavior:
 *   - With mic correctly routed and you speaking near the laptop:
 *     peak > 0.1, rms > 0.01
 *   - With mic OFF or silent:
 *     peak ≈ 0, rms ≈ 0
 *
 * Run via:
 *   ./gradlew connectedDebugAndroidTest --tests \
 *     "dev.orbit.dock.perception.MicCaptureDiagnosticTest"
 *
 * Then check logcat for the [MIC-DIAG] tag for the verdict.
 */
@RunWith(AndroidJUnit4::class)
class MicCaptureDiagnosticTest {

    @Test
    fun captureFifteenFramesAndReportAmplitude() = runTest {
        val mic = MicCapture(ApplicationProvider.getApplicationContext())
        val frames: List<ShortArray> = try {
            mic.frames().take(15).toList()
        } catch (t: Throwable) {
            // Most common failure on emulator: host mic access toggle is OFF
            // in Extended Controls. Report it loudly but don't fail the test —
            // this is a diagnostic, not a contract check.
            println("[MIC-DIAG] AudioRecord could not initialize: ${t.message}")
            println("[MIC-DIAG] VERDICT: NO_MIC_SOURCE")
            println("[MIC-DIAG]   → Extended Controls → Microphone → \"Enable Host")
            println("[MIC-DIAG]     Microphone Access\" is OFF, or macOS hasn't")
            println("[MIC-DIAG]     granted the emulator process mic permission.")
            return@runTest
        }
        assertThat(frames).hasSize(15)

        var peak = 0
        var sumSq = 0.0
        var sampleCount = 0L
        for (frame in frames) {
            for (s in frame) {
                if (s.toInt().absoluteValue > peak) peak = s.toInt().absoluteValue
                sumSq += (s.toDouble() / Short.MAX_VALUE).let { it * it }
                sampleCount++
            }
        }
        val rms = if (sampleCount > 0) sqrt(sumSq / sampleCount) else 0.0
        val normalizedPeak = peak.toFloat() / Short.MAX_VALUE

        val verdict = when {
            normalizedPeak > 0.10f -> "SIGNAL (mic delivering speech-level audio)"
            normalizedPeak > 0.005f -> "FAINT (mic delivering low-level audio — speak louder or check distance)"
            else -> "SILENCE (mic opened OK but audio is silent — host mic muted or no input)"
        }

        println("[MIC-DIAG] VERDICT: $verdict")
        println("[MIC-DIAG] frames=${frames.size} samples=$sampleCount peak=$peak normalizedPeak=$normalizedPeak rms=$rms")

        assertThat(frames.first().size).isEqualTo(MicCapture.FRAME_SIZE)
    }
}
