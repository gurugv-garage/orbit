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

    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { ev ->
            when (ev) {
                is PerceptionEvent.FaceSeen -> facePresent = true
                is PerceptionEvent.FaceLost -> facePresent = false
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

        // (The on-device FER read HUD was removed with the emotion path; the station's
        // face-api reads emotion from the SFU stream now — see
        // docs/decision-traces/thin-client-consolidation.md.)

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
