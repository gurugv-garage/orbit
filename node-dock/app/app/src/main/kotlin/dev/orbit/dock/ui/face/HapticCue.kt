package dev.orbit.dock.ui.face

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import timber.log.Timber

/**
 * Short HAPTIC cues for the listening on/off ("addressed") edges — the tactile
 * replacement for the old [BeepPlayer] tones.
 *
 * Why haptic, not a beep: the listening-OFF cue fired on `listening->thinking`,
 * immediately BEFORE TTS (`thinking->speaking`). The beep played on
 * STREAM_VOICE_CALL — the SAME WebRTC voice-comm path TTS now renders through —
 * so the blip collided with / ducked the start of the reply ("TTS gets blocked /
 * blobs"). A vibration uses the vibrator motor, NOT any audio stream, so it can
 * never interfere with TTS. The visual cue (the face Idle⇄Listening state) stays
 * too; this is the tactile half.
 *
 * Lazy + tolerant: [init] once with an app Context; if the device has no
 * vibrator (or it's disabled), cues are silently no-ops — never fatal. Requires
 * the VIBRATE permission (normal, no runtime prompt).
 */
object HapticCue {
    @Volatile private var vibrator: Vibrator? = null

    /** Wire the vibrator once (call at app/screen setup with any Context). */
    fun init(context: Context) {
        if (vibrator != null) return
        vibrator = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }?.takeIf { it.hasVibrator() }
        } catch (t: Throwable) {
            Timber.w(t, "Vibrator unavailable — haptic cues disabled")
            null
        }
    }

    /** Listening turned ON (addressed). A single short tick. */
    fun listeningOn() {
        Timber.i("HapticCue: listening ON")
        vibrate(longArrayOf(0, ON_MS))
    }

    /** Listening turned OFF (sentence-end / timeout). A double tick (distinct from ON). */
    fun listeningOff() {
        Timber.i("HapticCue: listening OFF")
        vibrate(longArrayOf(0, OFF_TICK_MS, OFF_GAP_MS, OFF_TICK_MS))
    }

    private fun vibrate(timings: LongArray) {
        val v = vibrator ?: return
        runCatching {
            // -1 = no repeat. createWaveform handles single + multi-tick patterns.
            v.vibrate(VibrationEffect.createWaveform(timings, -1))
        }
    }

    private const val ON_MS = 40L       // one crisp tick
    private const val OFF_TICK_MS = 25L // double-tick: tick…
    private const val OFF_GAP_MS = 60L  //              …gap…
}
