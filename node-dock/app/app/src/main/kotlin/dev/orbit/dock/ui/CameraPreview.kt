package dev.orbit.dock.ui

import androidx.camera.core.Preview
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * A small live camera thumbnail — "the dock's eye" — showing exactly what the
 * front camera (and thus the vision LLM) sees. Always on while the camera is
 * active; tap to toggle 3× size and back.
 *
 * Renders a CameraX [PreviewView] and hands its [Preview.SurfaceProvider] to
 * [setSurface] (the FaceTracker), which binds a Preview use-case alongside its
 * analyzer. On dispose it detaches the surface so the camera unbinds the
 * preview cleanly.
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

    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(16.dp))
            .border(1.dp, Color.White.copy(alpha = 0.25f), RoundedCornerShape(16.dp)),
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
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
        // Transparent tap target above the SurfaceView → tap-to-enlarge works.
        Box(
            modifier = Modifier
                .matchParentSize()
                .clickable { enlarged = !enlarged },
        )
    }

    DisposableEffect(Unit) {
        onDispose { setSurface(null) }
    }
}
