package dev.orbit.dock.perception

import android.content.Context
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Dispatchers
import timber.log.Timber

/**
 * 16 kHz mono PCM mic capture as a Kotlin `Flow<ShortArray>`, sourced from the
 * WebRTC audio engine ([WebRtcAudio]) so frames arrive **echo-cancelled** — the
 * mic no longer hears the dock's own TTS. This is what makes voice barge-in
 * possible (the mic can stay live while the dock speaks).
 *
 * Emits fixed-size frames so downstream consumers (VAD, wake word) get
 * predictable input lengths — the public contract is unchanged from the old raw
 * `AudioRecord` version, so VAD/wake/STT-gating are untouched.
 *
 * - Sample rate: 16 kHz mono PCM 16-bit signed
 * - Frame size: 512 samples (32 ms) — Silero VAD V5 expected chunk size
 *   Porcupine uses 512 samples internally as well (`Porcupine.frameLength`)
 *
 * WebRTC's ADM delivers 10 ms (160-sample @ 16 kHz) frames; we reframe them into
 * 512-sample chunks here. Like the previous version this is a *cold* flow: it
 * starts capture on collection and stops it on cancellation, so the pipeline can
 * release the mic (cancel the flow) to hand it to SpeechRecognizer.
 *
 * Caller is responsible for `RECORD_AUDIO` having been granted before subscribing.
 */
class MicCapture(
    private val context: Context,
    private val frameSize: Int = FRAME_SIZE,
) {

    fun frames(): Flow<ShortArray> = callbackFlow {
        // Accumulates incoming 10 ms PCM-16 frames and slices out 512-sample
        // frames. Only touched from the ADM callback thread (single producer).
        val carry = ShortArray(frameSize * 2)
        var carryLen = 0

        val sink = WebRtcAudio.FrameSink { pcm16, _ ->
            val shorts = pcm16.toShortsLE()
            var offset = 0
            while (offset < shorts.size) {
                val n = minOf(frameSize - carryLen, shorts.size - offset)
                System.arraycopy(shorts, offset, carry, carryLen, n)
                carryLen += n
                offset += n
                if (carryLen == frameSize) {
                    trySendBlocking(carry.copyOf(frameSize))
                    carryLen = 0
                }
            }
        }

        Timber.d("MicCapture starting (WebRTC ADM, frame=$frameSize)")
        WebRtcAudio.startCapture(context, sink)

        awaitClose {
            WebRtcAudio.stopCapture()
            Timber.d("MicCapture stopped")
        }
    }
        // Decouple the ADM callback thread from collectors; drop oldest under
        // back-pressure so VAD/wake never block the audio thread.
        .buffer(capacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)
        .flowOn(Dispatchers.IO)

    companion object {
        const val SAMPLE_RATE = WebRtcAudio.SAMPLE_RATE
        const val FRAME_SIZE = 512  // 32 ms @ 16 kHz
    }
}

/** Decode little-endian PCM-16 bytes into a ShortArray. */
private fun ByteArray.toShortsLE(): ShortArray {
    val out = ShortArray(size / 2)
    var j = 0
    var i = 0
    while (i + 1 < size) {
        out[j++] = ((this[i].toInt() and 0xFF) or (this[i + 1].toInt() shl 8)).toShort()
        i += 2
    }
    return out
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
