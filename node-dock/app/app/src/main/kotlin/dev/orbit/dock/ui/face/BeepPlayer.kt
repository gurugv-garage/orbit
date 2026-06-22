package dev.orbit.dock.ui.face

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import timber.log.Timber
import kotlin.math.PI
import kotlin.math.sin

/**
 * Short, LIGHT UI pips for the listening on/off ("addressed") edges — a discreet
 * audible cue that pairs with the haptic ([HapticCue]) + the visual face glow
 * ([ListeningGlow]).
 *
 * Design goals (vs the old ToneGenerator beep that collided with TTS + risked
 * being transcribed as speech):
 *  - **Synthesized pure sine** via a one-shot AudioTrack, so we control frequency,
 *    duration, and gain precisely (ToneGenerator only offers fixed DTMF tones).
 *  - **High frequency + very short + quiet** so the dock's own STT never reads it
 *    as a word: each pip is ~[PIP_MS] ms (well under the server VAD's
 *    MIN_UTTERANCE_MS ≈ 180 ms, so it endpoints to "too short → dropped"), at
 *    ~[ON_HZ]/[OFF_HZ] (near the top of / above the speech band) and low gain.
 *  - Plays on STREAM_VOICE_CALL (the WebRTC voice world ducks media to silence —
 *    same reason the old beep used it), but because it's so brief it can't
 *    meaningfully step on TTS the way the old longer beep did.
 *
 * Tolerant of AudioTrack failing (a missing pip is never fatal). Lazy; no assets.
 */
object BeepPlayer {

    /** Listening turned ON (addressed). A single light high pip (rising feel). */
    fun listeningOn() {
        Timber.i("BeepPlayer: listening ON")
        pip(ON_HZ, PIP_MS)
    }

    /** Listening turned OFF (sentence-end / timeout). A slightly higher, shorter blip. */
    fun listeningOff() {
        Timber.i("BeepPlayer: listening OFF")
        pip(OFF_HZ, PIP_MS - 15)
    }

    /** Render + play a single sine pip (with a tiny fade in/out so it doesn't click). */
    private fun pip(freqHz: Double, durationMs: Int) {
        runCatching {
            val sr = 44_100
            val n = sr * durationMs / 1000
            val pcm = ShortArray(n)
            val fadeN = (sr * 0.005).toInt() // 5 ms ramp each end (de-click)
            for (i in 0 until n) {
                val env = when {
                    i < fadeN -> i.toDouble() / fadeN
                    i > n - fadeN -> (n - i).toDouble() / fadeN
                    else -> 1.0
                }
                val s = sin(2.0 * PI * freqHz * i / sr) * GAIN * env
                pcm[i] = (s * Short.MAX_VALUE).toInt().toShort()
            }
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        // VOICE_COMMUNICATION_SIGNALLING = a brief UI tone in the
                        // voice world (won't be ducked to silence like media).
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .setLegacyStreamType(AudioManager.STREAM_VOICE_CALL)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sr)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(pcm.size * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(pcm, 0, pcm.size)
            track.setNotificationMarkerPosition(n)
            track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(t: AudioTrack?) { runCatching { t?.release() } }
                override fun onPeriodicNotification(t: AudioTrack?) {}
            })
            track.play()
        }.onFailure { Timber.w(it, "pip failed — UI tone skipped") }
    }

    private const val ON_HZ = 2_200.0   // light high pip — above the bulk of speech energy
    private const val OFF_HZ = 2_640.0  // a touch higher for the off edge
    private const val PIP_MS = 70       // « MIN_UTTERANCE_MS (~180ms) so STT drops it
    private const val GAIN = 0.18       // quiet — a discreet tick, not an alert
}
