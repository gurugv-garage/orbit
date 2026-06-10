package dev.orbit.dock.perception

import android.graphics.Bitmap
import java.nio.ByteBuffer
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoFrame
import org.webrtc.VideoSource
import org.webrtc.YuvHelper
import timber.log.Timber

/**
 * Feeds [FaceTracker]'s camera [Bitmap]s into a WebRTC [VideoSource] as I420
 * [VideoFrame]s, so the live stream's video track carries what the dock sees.
 *
 * Source frames are the throttled face-analysis frames (~1 Hz, 320×240) — see
 * [FaceTracker.onBitmapFrame]. This is deliberately a low-rate "slideshow" (we
 * reuse the analysis frames rather than open a second camera path); VP8 encodes
 * sparse frames fine. The conversion is ARGB_8888 → I420 via the native
 * [YuvHelper.ABGRToI420] (Android's ARGB_8888 is byte-order ABGR, which is what
 * this helper expects), so there's no hand-rolled YUV math.
 *
 * [onFrame] runs on FaceTracker's analyzer thread; it converts synchronously and
 * hands the [VideoFrame] to the source's capturer observer (which adapts/scales
 * and forwards to the encoder). The frame is ref-counted and released after push.
 */
class FaceFrameCapturer(private val source: VideoSource) {

    @Volatile private var started = false

    /** Begin delivering frames (drives the source's CapturerObserver lifecycle). */
    fun start() {
        if (started) return
        started = true
        source.capturerObserver.onCapturerStarted(true)
    }

    fun stop() {
        if (!started) return
        started = false
        try { source.capturerObserver.onCapturerStopped() } catch (_: Throwable) {}
    }

    /** Convert one upright ARGB_8888 bitmap to I420 and push it. Cheap, ~1 Hz. */
    fun onFrame(bitmap: Bitmap) {
        if (!started) return
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return

        // Pull ARGB_8888 pixels into a tightly-packed buffer (stride = w*4).
        val argb = ByteBuffer.allocateDirect(w * h * 4)
        val safe = if (bitmap.config == Bitmap.Config.ARGB_8888) bitmap
        else bitmap.copy(Bitmap.Config.ARGB_8888, false)
        safe.copyPixelsToBuffer(argb)
        argb.rewind()

        val i420 = JavaI420Buffer.allocate(w, h)
        try {
            YuvHelper.ABGRToI420(
                argb, w * 4,
                i420.dataY, i420.strideY,
                i420.dataU, i420.strideU,
                i420.dataV, i420.strideV,
                w, h,
            )
            // rotation already applied upstream (FaceTracker.rotated); 0 here.
            val frame = VideoFrame(i420, 0, System.nanoTime())
            try {
                source.capturerObserver.onFrameCaptured(frame)
            } finally {
                frame.release()
            }
        } catch (t: Throwable) {
            Timber.w(t, "FaceFrameCapturer: convert/push failed")
            i420.release()
        }
    }
}
