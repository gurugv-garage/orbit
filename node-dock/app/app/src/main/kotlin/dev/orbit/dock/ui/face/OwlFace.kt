package dev.orbit.dock.ui.face

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke

/**
 * Owl — a wise companion: very large round eyes inside feather-disc rings, with
 * ear tufts. Calm palette + voice. Reuses [DrawEyeFace] for the eyes.
 */
object OwlFace : Face {
    override val id = "owl"
    override val label = "Owl"
    override val voice = VoiceProfile(pitch = 0.95f, rate = 0.9f)
    override val palette = FacePalette(
        background = Color(0xFF0B0A06),
        eyeBase = Color(0xFFE9B84A),    // amber-gold
        eyeBright = Color(0xFFF7D070),
        eyeDim = Color(0xFF6B5320),
        eyeGlow = Color(0xFFC79A2E),
        cheek = Color(0xFFB98A5A),
        pupil = Color(0xFF120B02),
        catchlight = Color(0xFFFFF6DD),
        onBackground = Color(0xFFE6D9B5),
        accent = Color(0xFFFFD86B),
        bad = Color(0xFFD9774E),
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
                // Feather discs framing each big eye.
                val ring = Stroke(width = g.baseEyeRadius * 0.16f, cap = StrokeCap.Round)
                drawCircle(palette.eyeDim.copy(alpha = 0.7f), radius = g.baseEyeRadius * 1.5f, center = g.leftCenter, style = ring)
                drawCircle(palette.eyeDim.copy(alpha = 0.7f), radius = g.baseEyeRadius * 1.5f, center = g.rightCenter, style = ring)
                // Ear tufts above the outer edges.
                drawTuft(g.leftCenter, g.baseEyeRadius, isLeft = true)
                drawTuft(g.rightCenter, g.baseEyeRadius, isLeft = false)
                // Small beak between the eyes.
                if (!g.privacy) {
                    val beak = Path().apply {
                        moveTo(g.centerX, g.centerY + g.eyeRadius * 0.7f)
                        lineTo(g.centerX - g.eyeRadius * 0.28f, g.centerY + g.eyeRadius * 1.25f)
                        lineTo(g.centerX + g.eyeRadius * 0.28f, g.centerY + g.eyeRadius * 1.25f)
                        close()
                    }
                    drawPath(beak, palette.accent)
                }
            },
        )
    }

    private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawTuft(
        eyeCenter: Offset,
        baseR: Float,
        isLeft: Boolean,
    ) {
        val dir = if (isLeft) -1f else 1f
        val baseX = eyeCenter.x + dir * baseR * 1.1f
        val baseY = eyeCenter.y - baseR * 1.4f
        val path = Path().apply {
            moveTo(baseX - dir * baseR * 0.35f, baseY)
            lineTo(baseX + dir * baseR * 0.25f, baseY - baseR * 1.1f)
            lineTo(baseX + dir * baseR * 0.5f, baseY - baseR * 0.1f)
            close()
        }
        drawPath(path, palette.eyeDim, style = Stroke(width = baseR * 0.12f, join = StrokeJoin.Round))
        drawPath(path, palette.eyeDim.copy(alpha = 0.5f))
    }
}
