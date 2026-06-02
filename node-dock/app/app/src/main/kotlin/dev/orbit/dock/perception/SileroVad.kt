package dev.orbit.dock.perception

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import timber.log.Timber
import java.io.Closeable
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Silero VAD V5 — stateful per-frame speech probability.
 *
 * Input frames must be exactly 512 float samples at 16 kHz, range [-1..1].
 * The LSTM state is carried across calls — keep one instance per audio stream.
 *
 * Model file: `silero_vad.onnx` from
 *   https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/silero_vad.onnx
 * Bundled as an APK asset at assets/models/silero_vad.onnx.
 */
class SileroVad private constructor(
    private val env: OrtEnvironment,
    private val session: OrtSession,
) : Closeable {

    private var state = FloatArray(2 * 1 * 128)
    private val sr: OnnxTensor = OnnxTensor.createTensor(
        env,
        LongBuffer.wrap(longArrayOf(SAMPLE_RATE.toLong())),
        longArrayOf(),
    )

    private var callCount = 0

    /** Returns speech probability [0..1] for the given 512-sample frame. */
    fun probability(frame: FloatArray): Float {
        require(frame.size == FRAME_SIZE) {
            "Silero V5 requires exactly $FRAME_SIZE samples, got ${frame.size}"
        }
        val x = OnnxTensor.createTensor(env, FloatBuffer.wrap(frame), longArrayOf(1, FRAME_SIZE.toLong()))
        val s = OnnxTensor.createTensor(env, FloatBuffer.wrap(state), longArrayOf(2, 1, 128))
        val output = session.run(mapOf("input" to x, "state" to s, "sr" to sr))
        callCount++
        if (callCount <= 3) {
            Timber.tag("VAD_LIVE").i("CALL #$callCount frameSize=${frame.size} frameMax=${frame.max()}")
        }
        try {
            @Suppress("UNCHECKED_CAST")
            val prob = (output[0].value as Array<FloatArray>)[0][0]
            @Suppress("UNCHECKED_CAST")
            val stN = output[1].value as Array<Array<FloatArray>>
            // shape [2, 1, 128] → flat 256
            for (h in 0 until 2) {
                for (j in 0 until 128) state[h * 128 + j] = stN[h][0][j]
            }
            return prob
        } finally {
            output.close()
            x.close()
            s.close()
        }
    }

    fun reset() {
        state = FloatArray(state.size)
    }

    override fun close() {
        try { sr.close() } catch (_: Throwable) {}
        try { session.close() } catch (_: Throwable) {}
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_SIZE = 512

        const val ASSET_PATH = "models/silero_vad.onnx"

        fun fromAssets(context: Context): SileroVad? {
            return try {
                val bytes = context.assets.open(ASSET_PATH).use { it.readBytes() }
                val env = OrtEnvironment.getEnvironment()
                val opts = OrtSession.SessionOptions().apply {
                    setIntraOpNumThreads(1)
                    setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)
                }
                val session = env.createSession(bytes, opts)
                Timber.tag("VAD_LIVE").i("SileroVad loaded (${bytes.size / 1024} KB)")
                for (name in session.inputNames) {
                    val info = session.inputInfo[name]?.info
                    Timber.tag("VAD_LIVE").i("input '$name' info=$info")
                }
                for (name in session.outputNames) {
                    val info = session.outputInfo[name]?.info
                    Timber.tag("VAD_LIVE").i("output '$name' info=$info")
                }
                SileroVad(env, session)
            } catch (t: Throwable) {
                Timber.e(t, "SileroVad load failed — VAD will be disabled")
                null
            }
        }
    }
}
