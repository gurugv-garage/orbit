package dev.orbit.dock.ui

import androidx.camera.core.Preview
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.ui.face.EmotionReaction
import dev.orbit.dock.perception.PerceptionEvent
import kotlinx.coroutines.delay

/**
 * A small live camera thumbnail — "the dock's eye" — showing exactly what the
 * front camera (and thus the vision LLM) sees. Always on while the camera is
 * active; tap to toggle 3× size and back.
 *
 * Renders a CameraX [PreviewView] and hands its [Preview.SurfaceProvider] to
 * [setSurface] (the FaceTracker), which binds a Preview use-case alongside its
 * analyzer. On dispose it detaches the surface so the camera unbinds the
 * preview cleanly.
 *
 * Overlaid at the bottom is a live PERCEPTION STATUS line — face presence and
 * the on-device hand-gesture read (MediaPipe; see PalmDetector) — so what the
 * detector sees is visible right on the photo, not just in logcat. A palm flashes
 * "✋ PALM" briefly. (Debug/iteration affordance for the gesture work; the same
 * HandGesture event is the seam for gesture-driven listening later.)
 */
@Composable
fun CameraPreview(
    setSurface: (Preview.SurfaceProvider?) -> Unit,
    modifier: Modifier = Modifier,
    baseSize: androidx.compose.ui.unit.Dp = 96.dp,
) {
    var enlarged by remember { mutableStateOf(false) }
    val size by animateDpAsState(
        targetValue = if (enlarged) baseSize * 3 else baseSize,
        label = "preview-size",
    )

    // Live perception status for the overlay.
    var facePresent by remember { mutableStateOf(false) }
    var gesture by remember { mutableStateOf<String?>(null) }
    var gestureScore by remember { mutableStateOf(0f) }
    var palmFlash by remember { mutableStateOf(false) }
    // FER: what the camera reads on the USER's face, and how sure it is. Shown
    // because the number is the whole story and was invisible: the reaction
    // thresholds were set by intuition at 0.75 while this model actually emits
    // ~0.6 on a CLEAR read — so the dock could never react, and there was no way
    // to see that without a probe. Now the bar is on screen next to the face it
    // judges. (This is the USER's emotion — never the dock's own; see
    // docs/testing/face-harness.md.)
    var userEmotion by remember { mutableStateOf<String?>(null) }
    var userEmotionConf by remember { mutableStateOf(0f) }

    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { ev ->
            when (ev) {
                is PerceptionEvent.FaceSeen -> facePresent = true
                is PerceptionEvent.FaceLost -> {
                    facePresent = false
                    userEmotion = null
                }
                is PerceptionEvent.UserEmotion -> {
                    // Only write state on a MEANINGFUL change. FER is now
                    // LEVEL-triggered (re-emits ~1.4x/sec while a face is in
                    // frame — EmotionGate needs the repeats to measure
                    // persistence), and every write here recomposes the Box that
                    // holds the video AndroidView. This phone is a Redmi with no
                    // headroom (see the PERFORMANCE note below — TextureView was
                    // already "noticeably jerky" here), so a steady face must not
                    // cost ~84 pointless recompositions a minute. The 0.02 band
                    // kills EMA jitter that would never be visible at 2dp anyway.
                    if (ev.kind.name != userEmotion ||
                        kotlin.math.abs(ev.confidence - userEmotionConf) > 0.02f
                    ) {
                        userEmotion = ev.kind.name
                        userEmotionConf = ev.confidence
                    }
                }
                is PerceptionEvent.HandGesture -> {
                    gesture = ev.gesture
                    gestureScore = ev.score
                    if (ev.palm) palmFlash = true
                }
                else -> {}
            }
        }
    }
    // Clear the palm flash a beat after it fires.
    LaunchedEffect(palmFlash) {
        if (palmFlash) { delay(1_200); palmFlash = false }
    }

    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(16.dp))
            .border(1.dp, Color.White.copy(alpha = 0.25f), RoundedCornerShape(16.dp)),
    ) {
        AndroidView(
            modifier = Modifier.size(size),
            factory = { ctx ->
                PreviewView(ctx).apply {
                    // PERFORMANCE (SurfaceView) for smooth video on modest phones
                    // — TextureView (COMPATIBLE) is noticeably jerky on e.g. a
                    // Redmi 6 Pro. A SurfaceView swallows touches, so tap-to-
                    // enlarge is handled by a transparent overlay on top (below)
                    // rather than a .clickable on this view.
                    implementationMode = PreviewView.ImplementationMode.PERFORMANCE
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                    setSurface(surfaceProvider)
                }
            },
        )

        // FER read, pinned to the TOP (the bottom line is full: presence + gesture).
        // Colour-codes against the REACTION BAR, so you can see at a glance whether
        // this read is strong enough to move the dock's face — that gap is exactly
        // what was invisible when the bar sat at an unreachable 0.75:
        //   dim   = below the bar (ignored)
        //   green = clears it (the dock will react once it HOLDS ~2s)
        userEmotion?.let { kindName ->
            val kind = runCatching {
                PerceptionEvent.UserEmotion.Kind.valueOf(kindName)
            }.getOrNull()
            val bar = kind?.let { EmotionReaction.minConfidence(it) } ?: 1f
            val clears = userEmotionConf >= bar
            // "😠 0.62/0.50 → 🙁" — YOUR read, the bar it must clear, and the
            // dock's answer to it. The arrow is the react-don't-mirror fix made
            // visible: anger in, concern out. No arrow = this read moves nothing
            // (sleepy is deliberately ignored).
            val reaction = kind?.let { EmotionReaction.reactionTo(it) }
            val text = buildString {
                append(kind?.let { EmotionReaction.emojiFor(it) } ?: "·")
                append(" %.2f/%.2f".format(userEmotionConf, bar))
                if (clears && reaction != null) {
                    append(" → ").append(EmotionReaction.emojiForReaction(reaction))
                }
            }
            Text(
                text = text,
                color = if (clears) Color(0xFF7CFFB2) else Color.White.copy(alpha = 0.55f),
                fontSize = 9.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .background(Color.Black.copy(alpha = 0.45f))
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }

        // Live perception status line, pinned to the bottom of the thumbnail.
        val statusText = buildString {
            append(if (facePresent) "👤" else "·")
            append("  ")
            when {
                palmFlash -> append("✋ PALM")
                gesture == null -> append("✋ —")
                else -> append("✋ %s %d%%".format(shortGesture(gesture!!), (gestureScore * 100).toInt()))
            }
        }
        Text(
            text = statusText,
            color = if (palmFlash) Color(0xFF7CFFB2) else Color.White,
            fontSize = 9.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.45f))
                .padding(horizontal = 4.dp, vertical = 2.dp),
        )

        // Transparent tap target above the SurfaceView → tap-to-enlarge works.
        Box(
            modifier = Modifier
                .size(size)
                .clickable { enlarged = !enlarged },
        )
    }

    DisposableEffect(Unit) {
        onDispose { setSurface(null) }
    }
}

/** Compact label for the overlay ("Open_Palm" → "palm"). */
private fun shortGesture(g: String): String = when (g) {
    "Open_Palm" -> "palm"
    "Closed_Fist" -> "fist"
    "Pointing_Up" -> "point"
    "Thumb_Up" -> "thumb+"
    "Thumb_Down" -> "thumb-"
    "Victory" -> "peace"
    "ILoveYou" -> "ily"
    "None" -> "hand"
    else -> g.lowercase()
}
