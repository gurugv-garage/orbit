package dev.orbit.dock.ui.face

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path

/**
 * Baby dragon — big eyes with reptilian vertical-slit pupils, small horns, and a
 * snout. Playful, slightly gravelly voice. Reuses [DrawEyeFace] with
 * `slitPupil = true`; horns + snout drawn as overlays.
 */
object DragonFace : Face {
    override val id = "dragon"
    override val label = "Dragon"
    override val voice = VoiceProfile(pitch = 0.8f, rate = 1.05f)
    override val palette = FacePalette(
        background = Color(0xFF071009),
        eyeBase = Color(0xFF66E08A),    // emerald
        eyeBright = Color(0xFF9CF7B4),
        eyeDim = Color(0xFF2A5C39),
        eyeGlow = Color(0xFF3FCF6E),
        cheek = Color(0xFFE08A6B),
        pupil = Color(0xFF06160B),
        catchlight = Color(0xFFE9FFEF),
        onBackground = Color(0xFFCDE9D4),
        accent = Color(0xFFFFB347),     // ember
        bad = Color(0xFFFF6B5C),
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
            slitPupil = true,
            behind = { g ->
                // Two small horns curving back from above each eye.
                drawHorn(g.leftCenter, g.baseEyeRadius, isLeft = true)
                drawHorn(g.rightCenter, g.baseEyeRadius, isLeft = false)
            },
            overlay = { g ->
                if (!g.privacy) {
                    // Snout: a rounded muzzle with two nostril dots.
                    val snoutC = Offset(g.centerX, g.centerY + g.eyeRadius * 1.5f)
                    drawCircle(palette.eyeDim, radius = g.eyeRadius * 0.55f, center = snoutC)
                    drawCircle(palette.pupil, radius = g.eyeRadius * 0.08f,
                        center = Offset(snoutC.x - g.eyeRadius * 0.18f, snoutC.y))
                    drawCircle(palette.pupil, radius = g.eyeRadius * 0.08f,
                        center = Offset(snoutC.x + g.eyeRadius * 0.18f, snoutC.y))
                }
            },
        )
    }

    private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawHorn(
        eyeCenter: Offset,
        baseR: Float,
        isLeft: Boolean,
    ) {
        val dir = if (isLeft) -1f else 1f
        val rootX = eyeCenter.x + dir * baseR * 0.7f
        val rootY = eyeCenter.y - baseR * 1.3f
        val path = Path().apply {
            moveTo(rootX - dir * baseR * 0.22f, rootY)
            cubicTo(
                rootX + dir * baseR * 0.2f, rootY - baseR * 0.9f,
                rootX + dir * baseR * 0.9f, rootY - baseR * 1.2f,
                rootX + dir * baseR * 1.1f, rootY - baseR * 1.5f,
            )
            cubicTo(
                rootX + dir * baseR * 0.6f, rootY - baseR * 0.9f,
                rootX + dir * baseR * 0.3f, rootY - baseR * 0.3f,
                rootX + dir * baseR * 0.22f, rootY,
            )
            close()
        }
        drawPath(path, color = Color(0xFFD9C9A0))
    }
}
