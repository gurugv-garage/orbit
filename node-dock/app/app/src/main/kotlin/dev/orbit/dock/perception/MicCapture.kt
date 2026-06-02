package dev.orbit.dock.perception

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Dispatchers
import timber.log.Timber

/**
 * 16 kHz mono PCM mic capture as a Kotlin `Flow<ShortArray>`.
 *
 * Emits fixed-size frames so downstream consumers (VAD, wake word) get
 * predictable input lengths. Caller is responsible for `RECORD_AUDIO`
 * having been granted before subscribing.
 *
 * - Sample rate: 16 kHz mono PCM 16-bit signed
 * - Frame size: 512 samples (32 ms) — Silero VAD V5 expected chunk size
 *   Porcupine uses 512 samples internally as well (`Porcupine.frameLength`)
 */
class MicCapture(
    private val sampleRate: Int = SAMPLE_RATE,
    private val frameSize: Int = FRAME_SIZE,
) {

    @SuppressLint("MissingPermission")
    fun frames(): Flow<ShortArray> = flow {
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        // pad to ~10 frames to absorb scheduler jitter
        val bufBytes = (minBuf * 4).coerceAtLeast(frameSize * 2 * 10)

        val recorder = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufBytes,
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException("AudioRecord init failed (state=${recorder.state})")
        }

        recorder.startRecording()
        Timber.d("MicCapture started: sr=$sampleRate frame=$frameSize buf=$bufBytes bytes")
        try {
            val buf = ShortArray(frameSize)
            while (true) {
                var read = 0
                while (read < frameSize) {
                    val n = recorder.read(buf, read, frameSize - read)
                    if (n < 0) {
                        Timber.e("AudioRecord.read returned $n")
                        return@flow
                    }
                    read += n
                }
                emit(buf.copyOf())
            }
        } finally {
            try { recorder.stop() } catch (t: Throwable) { Timber.w(t, "stop failed") }
            recorder.release()
            Timber.d("MicCapture stopped")
        }
    }.flowOn(Dispatchers.IO)

    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_SIZE = 512  // 32 ms @ 16 kHz
    }
}

/** Compute RMS over a PCM short frame, normalized to [0, 1]. */
fun ShortArray.rmsLevel(): Float {
    if (isEmpty()) return 0f
    var sumSq = 0.0
    for (s in this) sumSq += (s.toDouble() / Short.MAX_VALUE).let { it * it }
    val rms = kotlin.math.sqrt(sumSq / size).toFloat()
    return rms.coerceIn(0f, 1f)
}

/** Convert a short PCM frame to float [-1..1]. Silero needs float input. */
fun ShortArray.toFloat32(): FloatArray = FloatArray(size) { i -> this[i].toFloat() / 32_768f }
