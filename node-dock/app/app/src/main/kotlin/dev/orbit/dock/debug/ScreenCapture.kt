package dev.orbit.dock.debug

import android.app.Activity
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import timber.log.Timber

/**
 * TEST HOOK — capture what the dock's screen ACTUALLY shows, as a JPEG.
 *
 * WHY THIS EXISTS: this dock has no adb (deploys are OTA), so `adb screencap`
 * — the way [dev.orbit.dock.FaceGalleryActivity] was meant to be used — is not
 * available. The face was therefore unverifiable from off-device, and it showed:
 * a "sweat bead" shipped that still rendered as a TEAR, because its geometry was
 * only ever reasoned about, never looked at. A drawing bug is invisible to every
 * unit test in the repo. The only real check is a picture.
 *
 * The station drives this over the existing `face` cap; the JPEG comes back
 * base64 in the tool-result, exactly like the camera-frame upload already does
 * (RemoteBrain turn-request `imageBase64`). See docs/testing/face-harness.md.
 *
 * Kept in `main` (not `src/debug`) deliberately: the OTA build is a RELEASE
 * build, so a debug-only hook could never run on the real dock — which is the
 * only place the face actually renders.
 */
object ScreenCapture {

    /** The live activity, set by MainActivity. Weak-ish: cleared on destroy. */
    @Volatile
    var activity: Activity? = null

    /**
     * Capture the current window as a downscaled JPEG, base64'd.
     *
     * Downscale + quality are deliberate: the face is flat colour on a dark
     * field, so it survives hard compression, and the result rides a JSON WS
     * frame — a full-res PNG would be megabytes per sample and the sampler takes
     * many. `maxWidth=480, quality=70` keeps a sample well under ~40KB while the
     * eyes/brows/accent stay unambiguous.
     *
     * Returns null (never throws) if there's no window yet or the copy fails —
     * a probe must never crash the dock it's observing.
     */
    suspend fun jpegBase64(maxWidth: Int = 480, quality: Int = 70): String? {
        val act = activity ?: run {
            Timber.w("ScreenCapture: no activity bound")
            return null
        }
        val window = act.window ?: return null
        val view = window.decorView
        val w = view.width
        val h = view.height
        if (w <= 0 || h <= 0) return null

        val bmp = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                copyViaPixelCopy(window, w, h)
            } else {
                // PixelCopy needs API 26+; minSdk is 26, so this is unreachable.
                null
            }
        } catch (t: Throwable) {
            Timber.w(t, "ScreenCapture: copy failed")
            null
        } ?: return null

        return try {
            val scaled = if (bmp.width > maxWidth) {
                val ratio = maxWidth.toFloat() / bmp.width
                Bitmap.createScaledBitmap(bmp, maxWidth, (bmp.height * ratio).toInt(), true)
            } else bmp
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (scaled !== bmp) scaled.recycle()
            bmp.recycle()
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (t: Throwable) {
            Timber.w(t, "ScreenCapture: encode failed")
            null
        }
    }

    private suspend fun copyViaPixelCopy(
        window: android.view.Window,
        w: Int,
        h: Int,
    ): Bitmap? = suspendCancellableCoroutine { cont ->
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        PixelCopy.request(window, bmp, { result ->
            if (result == PixelCopy.SUCCESS) {
                cont.resume(bmp)
            } else {
                Timber.w("ScreenCapture: PixelCopy result=$result")
                bmp.recycle()
                cont.resume(null)
            }
        }, Handler(Looper.getMainLooper()))
    }
}
