package dev.orbit.dock.ui.face

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * A soft, breathing EDGE GLOW drawn over the whole face area to signal the dock is
 * LISTENING — a calm "I'm attending to you" cue that works for EVERY face style
 * (it's a host overlay, not per-face) and pairs with the haptic + beep cues.
 *
 * Drawn as a radial gradient hugging the screen edges (transparent center → tinted
 * rim), pulsing opacity ~every 1.6 s. Fades fully out when not listening so it
 * never competes with Speaking/Idle. Tinted by the active face's accent so it
 * matches Aurora/Robot/Vader/etc.
 *
 * @param listening whether the dock is in a listening (or follow-up) state.
 * @param accent    the glow colour (use the active face's palette accent/eye colour).
 */
@Composable
fun ListeningGlow(
    listening: Boolean,
    accent: Color,
    modifier: Modifier = Modifier,
) {
    // Breathing opacity while listening; animates to 0 when it stops (no abrupt cut).
    val transition = rememberInfiniteTransition(label = "listening-glow")
    val pulse by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1_600, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "glow-pulse",
    )
    // Target intensity gates the whole effect on `listening`; the color tween makes
    // it fade in/out smoothly instead of popping.
    val rimColor by animateColorAsState(
        targetValue = if (listening) accent.copy(alpha = 0.9f * pulse) else Color.Transparent,
        animationSpec = tween(durationMillis = 450),
        label = "glow-rim",
    )

    // Brighten the accent toward white so the halo reads clearly even when a face's
    // eyeGlow is dark; alpha still carries the pulse + listening gate.
    val glow = Color(
        red = (accent.red + (1f - accent.red) * 0.35f),
        green = (accent.green + (1f - accent.green) * 0.35f),
        blue = (accent.blue + (1f - accent.blue) * 0.35f),
        alpha = rimColor.alpha,
    )

    androidx.compose.foundation.layout.Box(
        modifier = modifier
            .fillMaxSize()
            .drawBehind {
                if (glow.alpha <= 0.01f) return@drawBehind
                // Four edge bands (each a gradient from the lit edge → transparent
                // inward). Reads as a clear halo hugging the screen border, on any
                // aspect ratio, regardless of face. Band depth ≈ 22% of each side.
                val w = size.width; val h = size.height
                val depthX = w * 0.22f; val depthY = h * 0.22f
                // top
                drawRect(
                    brush = Brush.verticalGradient(
                        listOf(glow, Color.Transparent), startY = 0f, endY = depthY,
                    ),
                    size = androidx.compose.ui.geometry.Size(w, depthY),
                )
                // bottom
                drawRect(
                    brush = Brush.verticalGradient(
                        listOf(Color.Transparent, glow), startY = h - depthY, endY = h,
                    ),
                    topLeft = Offset(0f, h - depthY),
                    size = androidx.compose.ui.geometry.Size(w, depthY),
                )
                // left
                drawRect(
                    brush = Brush.horizontalGradient(
                        listOf(glow, Color.Transparent), startX = 0f, endX = depthX,
                    ),
                    size = androidx.compose.ui.geometry.Size(depthX, h),
                )
                // right
                drawRect(
                    brush = Brush.horizontalGradient(
                        listOf(Color.Transparent, glow), startX = w - depthX, endX = w,
                    ),
                    topLeft = Offset(w - depthX, 0f),
                    size = androidx.compose.ui.geometry.Size(depthX, h),
                )
            },
    ) {}
}
