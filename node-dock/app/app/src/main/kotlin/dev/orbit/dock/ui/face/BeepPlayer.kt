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
            // STREAM_VOICE_CALL (not MUSIC): WebRTC holds an active VOICE_COMMUNICATION
            // session which DUCKS media-stream audio to near-silence (the same reason
            // TTS had to move off USAGE_ASSISTANT). Play the beep in the voice-comm
            // world so it's actually audible. Max gain (100) — it's a brief blip.
            ToneGenerator(AudioManager.STREAM_VOICE_CALL, 100).also { tone = it }
        } catch (t: Throwable) {
            Timber.w(t, "ToneGenerator unavailable — beeps disabled")
            null
        }
    }

    /** Listening turned ON (tap → addressed). A clear rising cue (~180 ms). */
    fun listeningOn() {
        Timber.i("BeepPlayer: listening ON")
        runCatching { gen()?.startTone(ToneGenerator.TONE_PROP_BEEP, 180) }
    }

    /** Listening turned OFF (sentence-end / timeout). A lower falling cue (~180 ms). */
    fun listeningOff() {
        Timber.i("BeepPlayer: listening OFF")
        runCatching { gen()?.startTone(ToneGenerator.TONE_PROP_BEEP2, 180) }
    }

    fun release() {
        runCatching { tone?.release() }
        tone = null
    }
}
