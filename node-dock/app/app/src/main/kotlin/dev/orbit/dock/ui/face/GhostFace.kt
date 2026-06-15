package dev.orbit.dock.ui.face

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path

/**
 * Ghost — a translucent floating spirit: a wispy body with a wavy lower hem and
 * hollow oval eyes. Reuses [DrawEyeFace] for mood-driven eyes (low-alpha cool
 * palette); the body is drawn behind. Airy, drawn-out voice.
 */
object GhostFace : Face {
    override val id = "ghost"
    override val label = "Ghost"
    override val voice = VoiceProfile(pitch = 0.85f, rate = 0.85f)
    override val palette = FacePalette(
        background = Color(0xFF05060A),
        eyeBase = Color(0xFFBFD0E8),
        eyeBright = Color(0xFFE3ECFA),
        eyeDim = Color(0xFF4A5468),
        eyeGlow = Color(0xFF8FA6CC),
        cheek = Color(0xFF8FA6CC),
        pupil = Color(0xFF0A0C12),
        catchlight = Color(0xFFF2F6FF),
        onBackground = Color(0xFFD2DCEE),
        accent = Color(0xFFAFC2E6),
        bad = Color(0xFFE08A8A),
    )

    @Composable
    override fun Render(
        modifier: Modifier,
        state: FaceState,
        gaze: GazeOffset,
        expression: FaceExpression,
        privacy: Boolean,
        eyesClosed: Boolean,
        compactFraction: Float,
        staticForScreenshot: Boolean,
    ) {
        DrawEyeFace(
            modifier = modifier, state = state, gaze = gaze, expression = expression,
            privacy = privacy, eyesClosed = eyesClosed, compactFraction = compactFraction,
            staticForScreenshot = staticForScreenshot, palette = palette,
            behind = { g ->
                // Wispy translucent body: rounded dome over the eyes with a
                // wavy bottom hem, drawn low-alpha so it reads as a ghost.
                val r = g.baseEyeRadius
                val left = g.centerX - r * 2.6f
                val right = g.centerX + r * 2.6f
                val top = g.centerY - r * 2.4f
                val hemY = g.centerY + r * 2.6f
                val body = Path().apply {
                    moveTo(left, hemY)
                    // up the left side and over the dome
                    cubicTo(left, top, g.centerX - r * 1.2f, top - r * 0.8f, g.centerX, top - r * 0.8f)
                    cubicTo(g.centerX + r * 1.2f, top - r * 0.8f, right, top, right, hemY)
                    // wavy hem (3 humps) back to the left
                    val humps = 3
                    val span = right - left
                    for (i in 0 until humps) {
                        val x1 = right - span * (i + 0.5f) / humps
                        val x2 = right - span * (i + 1f) / humps
                        quadraticTo(x1, hemY + r * 0.5f, x2, hemY)
                    }
                    close()
                }
                drawPath(body, color = palette.eyeGlow.copy(alpha = 0.14f))
                drawPath(body, color = palette.onBackground.copy(alpha = 0.06f))
            },
            overlay = { g ->
                // Hollow O mouth when not already mouthing a mood, for the
                // classic "Boo" look on Surprised handled by the engine anyway.
                if (!g.privacy && expression == FaceExpression.Neutral) {
                    val m = Offset(g.centerX, g.centerY + g.eyeRadius * 1.7f)
                    drawOval(
                        color = palette.pupil.copy(alpha = 0.8f),
                        topLeft = Offset(m.x - g.eyeRadius * 0.22f, m.y - g.eyeRadius * 0.3f),
                        size = Size(g.eyeRadius * 0.44f, g.eyeRadius * 0.6f),
                    )
                }
            },
        )
    }
}
