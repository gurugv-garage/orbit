package dev.orbit.dock.perception

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Rect
import timber.log.Timber
import java.io.Closeable
import java.nio.FloatBuffer

/**
 * Microsoft FER+ ONNX model wrapper. 8-class facial emotion classifier.
 *
 * Input: 1×1×64×64 float32, grayscale image, 0–255 range.
 * Output: 1×8 logits → softmax → probability per class.
 *
 * Classes (canonical FER+ ordering):
 *   0 neutral
 *   1 happiness
 *   2 surprise
 *   3 sadness
 *   4 anger
 *   5 disgust
 *   6 fear
 *   7 contempt
 *
 * Model file:
 *   assets/models/emotion_ferplus.onnx — fetched by scripts/fetch-models.sh
 *   from https://github.com/onnx/models (validated FER+ canonical, ~35 MB).
 */
class FerOnnx private constructor(
    private val env: OrtEnvironment,
    private val session: OrtSession,
    private val inputName: String,
) : Closeable {

    /** 8 emotion classes in canonical FER+ order. */
    enum class Emotion {
        Neutral, Happiness, Surprise, Sadness,
        Anger, Disgust, Fear, Contempt,
    }

    data class Result(val emotion: Emotion, val probs: FloatArray) {
        val confidence: Float get() = probs.getOrElse(emotion.ordinal) { 0f }
    }

    /**
     * Classify a face crop. Caller must supply a square-ish RGB(A) bitmap
     * — we resample to 64×64 grayscale internally. Returns null on failure.
     */
    fun classify(faceCrop: Bitmap): Result? = try {
        val gray = toGray64(faceCrop)
        val buf = FloatBuffer.wrap(gray)
        val input = OnnxTensor.createTensor(env, buf, longArrayOf(1, 1, 64, 64))
        session.run(mapOf(inputName to input)).use { out ->
            @Suppress("UNCHECKED_CAST")
            val logits = (out[0].value as Array<FloatArray>)[0]
            val probs = softmax(logits)
            val top = probs.indices.maxBy { probs[it] }
            Result(Emotion.entries[top], probs)
        }.also {
            input.close()
        }
    } catch (t: Throwable) {
        Timber.w(t, "FER inference failed")
        null
    }

    override fun close() {
        try { session.close() } catch (_: Throwable) {}
    }

    companion object {
        const val ASSET_PATH = "models/emotion_ferplus.onnx"

        fun fromAssets(context: Context): FerOnnx? = try {
            val bytes = context.assets.open(ASSET_PATH).use { it.readBytes() }
            val env = OrtEnvironment.getEnvironment()
            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(1)
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)
            }
            val session = env.createSession(bytes, opts)
            val inputName = session.inputNames.first()
            Timber.i("FerOnnx loaded (${bytes.size / 1024} KB), input=$inputName")
            FerOnnx(env, session, inputName)
        } catch (t: Throwable) {
            Timber.w(t, "FerOnnx load failed — FER will be disabled")
            null
        }

        private fun softmax(logits: FloatArray): FloatArray {
            val max = logits.max()
            var sum = 0f
            val out = FloatArray(logits.size) { i ->
                val e = kotlin.math.exp((logits[i] - max).toDouble()).toFloat()
                sum += e
                e
            }
            for (i in out.indices) out[i] /= sum
            return out
        }

        /**
         * Bitmap → 64×64 grayscale float[4096], 0–255 range. Uses Android's
         * native bitmap scaling (bilinear) then a grayscale ColorMatrix
         * filter so we don't write a custom resampler.
         */
        private fun toGray64(src: Bitmap): FloatArray {
            val w = 64
            val h = 64
            val scaled = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(scaled)
            val paint = Paint().apply {
                isFilterBitmap = true
                colorFilter = ColorMatrixColorFilter(ColorMatrix().apply {
                    setSaturation(0f)
                })
            }
            val srcRect = Rect(0, 0, src.width, src.height)
            val dstRect = Rect(0, 0, w, h)
            canvas.drawBitmap(src, srcRect, dstRect, paint)
            val px = IntArray(w * h)
            scaled.getPixels(px, 0, w, 0, 0, w, h)
            scaled.recycle()
            return FloatArray(w * h) { i ->
                // After ColorMatrix saturation=0 the R/G/B channels are equal;
                // pick R as the luminance value, leave in 0..255 range.
                ((px[i] shr 16) and 0xFF).toFloat()
            }
        }
    }
}
