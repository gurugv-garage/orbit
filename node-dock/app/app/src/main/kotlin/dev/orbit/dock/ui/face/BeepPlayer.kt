package dev.orbit.dock.ui.face

import android.media.AudioManager
import android.media.ToneGenerator
import timber.log.Timber

/**
 * Short UI beeps for listening on/off (A1.2). The dock's mic is ALWAYS on, so the
 * beeps mark the "addressed" mode the user cares about: a tap opens it (rising
 * cue), sentence-end / timeout closes it (falling cue) — the same affordance a
 * voice assistant gives so you know when it's actually attending to you.
 *
 * Uses [ToneGenerator] (synthesized DTMF-style tones, no asset files, instant).
 * Plays on STREAM_MUSIC so it's audible like any UI sound. Cheap + lazy; tolerant
 * of the generator failing (some OEMs limit ToneGenerator) — a missing beep is
 * never fatal.
 *
 * NOTE: these beeps play through the device speaker like any media sound. With the
 * A1 AEC (TTS rendered through WebRTC), the beep is NOT WebRTC-rendered, so it is
 * not an AEC reference — but it's a sub-200 ms blip, so even if the mic hears a
 * faint click it won't transcribe as speech (the VAD/Whisper ignore it).
 */
object BeepPlayer {
    @Volatile private var tone: ToneGenerator? = null

    private fun gen(): ToneGenerator? {
        tone?.let { return it }
        return try {
            ToneGenerator(AudioManager.STREAM_MUSIC, 70).also { tone = it } // 0..100 volume
        } catch (t: Throwable) {
            Timber.w(t, "ToneGenerator unavailable — beeps disabled")
            null
        }
    }

    /** Listening turned ON (tap → addressed). A short, higher rising cue. */
    fun listeningOn() {
        runCatching { gen()?.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
    }

    /** Listening turned OFF (sentence-end / timeout). A short, lower falling cue. */
    fun listeningOff() {
        runCatching { gen()?.startTone(ToneGenerator.TONE_PROP_BEEP2, 120) }
    }

    fun release() {
        runCatching { tone?.release() }
        tone = null
    }
}
