package dev.orbit.dock.perception

import ai.picovoice.porcupine.Porcupine
import ai.picovoice.porcupine.PorcupineException
import android.content.Context
import timber.log.Timber
import java.io.Closeable

/**
 * Porcupine-based wake-word detector. Free tier requires an AccessKey from
 * https://console.picovoice.ai/ — read from BuildConfig.PORCUPINE_ACCESS_KEY
 * (populated from local.properties).
 *
 * If no key is set, this stays in *disabled* mode and never fires. The
 * debug build's "fake wake" button can still exercise the downstream flow.
 *
 * Built-in wake word: `Porcupine.BuiltInKeyword.JARVIS` ("hey jarvis" via the
 * built-in keyword "jarvis"). Porcupine frame length = 512 samples @ 16 kHz,
 * which matches our MicCapture frame size — no resampling needed.
 */
class PorcupineWakeWord private constructor(
    private val porcupine: Porcupine,
    val label: String,
) : Closeable {

    /** Returns >=0 keyword index if the wake word fired, else -1. */
    fun process(frame: ShortArray): Int {
        return try {
            porcupine.process(frame)
        } catch (e: PorcupineException) {
            Timber.e(e, "Porcupine.process failed")
            -1
        }
    }

    override fun close() {
        try { porcupine.delete() } catch (_: Throwable) {}
    }

    companion object {
        /**
         * Create using the built-in JARVIS keyword. Returns null if no
         * AccessKey is configured or initialization fails (e.g. quota / invalid key).
         */
        fun jarvis(
            context: Context,
            accessKey: String,
        ): PorcupineWakeWord? {
            if (accessKey.isBlank()) {
                Timber.w("Porcupine: no AccessKey set; wake-word disabled. " +
                    "Add PORCUPINE_ACCESS_KEY to local.properties.")
                return null
            }
            return try {
                val porcupine = Porcupine.Builder()
                    .setAccessKey(accessKey)
                    .setKeyword(Porcupine.BuiltInKeyword.JARVIS)
                    .setSensitivity(0.5f)
                    .build(context)
                Timber.d("Porcupine ready (frameLength=${porcupine.frameLength}, sampleRate=${porcupine.sampleRate})")
                PorcupineWakeWord(porcupine, "hey jarvis")
            } catch (e: PorcupineException) {
                Timber.e(e, "Porcupine init failed — wake-word disabled")
                null
            } catch (t: Throwable) {
                Timber.e(t, "Porcupine init failed (unexpected) — wake-word disabled")
                null
            }
        }
    }
}
