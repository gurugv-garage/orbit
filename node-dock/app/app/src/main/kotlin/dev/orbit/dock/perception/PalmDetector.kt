package dev.orbit.dock.perception

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer
import timber.log.Timber
import java.io.Closeable

/**
 * On-device PALM detector built on MediaPipe's Gesture Recognizer
 * (`assets/models/gesture_recognizer.task`, fetched by scripts/fetch-models.sh).
 *
 * The trigger is simply an OPEN PALM held up to the camera (`Open_Palm`) — no
 * waving motion required. It fires on the RISING EDGE (the moment a palm appears
 * after being absent), so holding a palm up doesn't re-fire and a palm resting in
 * frame doesn't keep triggering. Drop the hand and raise it again to fire again.
 * A short consecutive-frame confirmation guards against single-frame misreads.
 *
 * Emits a [PerceptionEvent.HandGesture] each (throttled) frame for the overlay,
 * with `palm = true` on the firing frame. Consumed by DockScreen (address /
 * interrupt / stop, mirror of a tap) + the CameraPreview overlay.
 *
 * Runs in IMAGE mode (synchronous `recognize()`), called from the FaceTracker's
 * analyzer thread on the SAME upright bitmap it already decodes — no second
 * camera stream. The caller self-throttles cadence (see PALM_INTERVAL_NS in
 * FaceTracker), leaving CPU for the preview/face/FER path on a modest phone.
 */
class PalmDetector private constructor(
    private val recognizer: GestureRecognizer,
) : Closeable {

    // Rising-edge palm state.
    //  - `palmStreak`  = consecutive open-palm frames (a short confirmation against
    //                    single-frame misreads) before a fire.
    //  - `awayStreak`  = consecutive NON-palm frames; re-arming requires the palm to
    //                    be GONE for a sustained stretch (PALM_AWAY_FRAMES), not a
    //                    one-frame flicker — otherwise holding a palm up (MediaPipe
    //                    briefly drops to None/fist mid-hold) would re-arm and the
    //                    repeated fire would TOGGLE the server window shut.
    //  - `palmArmed`   = whether the next confirmed palm may fire (false after a fire
    //                    until the palm has been sustainedly away).
    private var palmStreak = 0
    private var awayStreak = 0
    private var palmArmed = true

    private var lastFireMs = 0L
    // Overlay status throttle.
    private var lastStatusMs = 0L
    private var lastGesture: String? = null

    /**
     * Feed one upright camera frame. Returns true (and logs) when a palm is
     * detected (rising edge). Never throws — a recognition/parse failure is
     * logged and swallowed so the analyzer loop is never disrupted.
     *
     * @param tsMs a monotonically-increasing timestamp for this frame (ms).
     */
    fun onFrame(bitmap: Bitmap, tsMs: Long): Boolean {
        return try {
            val mpImage = BitmapImageBuilder(bitmap).build()
            val result = recognizer.recognize(mpImage)

            // TRIGGER = an OPEN PALM is shown (no waving motion needed). We fire
            // on the RISING EDGE — the moment a palm appears after being absent —
            // so HOLDING a palm up doesn't re-fire every frame, and a palm resting
            // in frame doesn't keep re-triggering. Drop the hand and raise it again
            // to fire again.
            val topGesture = result.gestures().firstOrNull()?.firstOrNull()
            val gestureName = topGesture?.categoryName()
            val gestureScore = topGesture?.score() ?: 0f
            val handPresent = result.landmarks().isNotEmpty()
            val isOpenPalm = handPresent && gestureName == OPEN_PALM && gestureScore >= PALM_MIN_SCORE

            if (!isOpenPalm) {
                // Not a palm this frame (no hand, or a non-palm gesture, or a mid-
                // hold flicker). Count sustained absence; only re-arm once the palm
                // has been GONE long enough (PALM_AWAY_FRAMES) — a single flicker
                // while holding a palm up must NOT re-arm (that would double-fire and
                // toggle the server window shut).
                palmStreak = 0
                awayStreak++
                if (awayStreak >= PALM_AWAY_FRAMES) palmArmed = true
                emitStatus(tsMs, gestureName, gestureScore, palm = false)
                return false
            }

            // Open palm this frame. Require a couple of consecutive palm frames so a
            // single-frame misread doesn't trigger.
            awayStreak = 0
            palmStreak++
            val confirmed = palmStreak >= PALM_CONFIRM_FRAMES
            val fire = confirmed && palmArmed && (tsMs - lastFireMs >= PALM_COOLDOWN_MS)
            emitStatus(tsMs, gestureName, gestureScore, palm = fire, force = fire)
            if (fire) {
                lastFireMs = tsMs
                palmArmed = false // disarm until the palm is sustainedly away (no re-fire while held)
                Timber.tag(TAG).i("PALM detected (score=%.2f)".format(gestureScore))
                return true
            }
            false
        } catch (t: Throwable) {
            Timber.tag(TAG).w(t, "palm recognize failed")
            false
        }
    }

    override fun close() {
        try { recognizer.close() } catch (_: Throwable) {}
    }

    /**
     * Publish the live hand-gesture status for the on-screen overlay. Throttled
     * to STATUS_INTERVAL_MS (the recognizer runs ~6 Hz; the overlay doesn't need
     * every frame), but `force` bypasses the throttle so a palm fire shows
     * instantly. Also coalesces: skip an unchanged "no hand" status so an empty
     * room is quiet on the bus.
     */
    private fun emitStatus(tsMs: Long, gesture: String?, score: Float, palm: Boolean, force: Boolean = false) {
        if (!force) {
            if (tsMs - lastStatusMs < STATUS_INTERVAL_MS) return
            if (gesture == null && lastGesture == null && !palm) { lastStatusMs = tsMs; return }
        }
        lastStatusMs = tsMs
        lastGesture = gesture
        PerceptionBus.emit(PerceptionEvent.HandGesture(gesture, score, palm))
    }

    companion object {
        const val TAG = "PALM_LIVE"
        const val ASSET_PATH = "models/gesture_recognizer.task"

        // MediaPipe's built-in canonical category for an open palm.
        private const val OPEN_PALM = "Open_Palm"

        private const val PALM_MIN_SCORE = 0.45f    // open-palm classifier confidence
        private const val PALM_CONFIRM_FRAMES = 2   // consecutive palm frames before firing
        private const val PALM_AWAY_FRAMES = 5      // consecutive non-palm frames (~0.8s @ 6Hz)
                                                    // before re-arming — survives mid-hold flicker
        private const val PALM_COOLDOWN_MS = 2_500L // hard floor between fires (debounce)
        private const val STATUS_INTERVAL_MS = 250L // overlay status emit throttle

        /**
         * Build the recognizer from the bundled `.task` asset. Returns null on
         * any failure (asset missing / parse / native init) — the caller treats
         * a null detector as "palm detection disabled".
         */
        fun fromAssets(context: Context): PalmDetector? = try {
            val base = BaseOptions.builder()
                .setModelAssetPath(ASSET_PATH)
                .build()
            val options = GestureRecognizer.GestureRecognizerOptions.builder()
                .setBaseOptions(base)
                .setRunningMode(RunningMode.IMAGE)
                .setNumHands(1)
                .build()
            val recognizer = GestureRecognizer.createFromOptions(context, options)
            Timber.tag(TAG).i("PalmDetector loaded ($ASSET_PATH)")
            PalmDetector(recognizer)
        } catch (t: Throwable) {
            Timber.tag(TAG).w(t, "PalmDetector load failed — palm detection disabled")
            null
        }
    }
}
