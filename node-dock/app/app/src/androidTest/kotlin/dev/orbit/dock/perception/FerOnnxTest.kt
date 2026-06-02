package dev.orbit.dock.perception

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.truth.Truth.assertThat
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Sanity check that the bundled FER+ ONNX model loads and runs end-to-end
 * on the device/emulator. Doesn't assert the predicted emotion — we feed
 * it synthetic crops, no real faces — only that load + inference + softmax
 * complete without throwing and produce a probability vector that sums to 1.
 */
@RunWith(AndroidJUnit4::class)
class FerOnnxTest {

    @Test
    fun loadsFromAssetsAndReturnsProbabilities() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val fer = FerOnnx.fromAssets(ctx)
        assertThat(fer).isNotNull()

        // Synthetic input — a grey 200x200 face crop with a single dark dot.
        val bmp = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(Color.rgb(180, 180, 180))
        c.drawCircle(100f, 100f, 30f, Paint().apply { color = Color.rgb(40, 40, 40) })

        val result = fer!!.classify(bmp)
        assertThat(result).isNotNull()

        val probs = result!!.probs
        assertThat(probs).hasLength(FerOnnx.Emotion.entries.size)
        val sum = probs.sum()
        assertThat(sum).isWithin(0.01f).of(1f)
        // confidence of the picked emotion is the max prob
        assertThat(result.confidence).isAtLeast(probs.max())

        fer.close()
    }
}
