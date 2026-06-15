package dev.orbit.dock.ui.face

import androidx.compose.animation.core.EaseInOutCubic
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate

/**
 * Darth Vader — a fully custom face: a dark helmet dome with triangular red eye
 * lenses, a vertical grille and mouth vents. No soft eyes; mood is conveyed by
 * lens brightness/colour + a subtle head tilt. Accents are suppressed (Vader
 * doesn't sparkle). Low, slow voice.
 *
 * Uses [rememberFaceFrame] only for shared timing (breath, tilt, blink-as-lens-
 * dim, the expression tween); all drawing is custom.
 */
object VaderFace : Face {
    override val id = "vader"
    override val label = "Vader"
    override val voice = VoiceProfile(pitch = 0.7f, rate = 0.9f)
    override val palette = FacePalette(
        background = Color(0xFF020203),
        eyeBase = Color(0xFFCC2222),
        eyeBright = Color(0xFFFF4D4D),
        eyeDim = Color(0xFF5A1010),
        onBackground = Color(0xFFB9C0C6),
    )

    private val helmet = Color(0xFF0C0E10)
    private val helmetEdge = Color(0xFF24282C)

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
        val frame = rememberFaceFrame(state, expression, privacy, eyesClosed, staticForScreenshot)
        val shape = frame.shape

        // Lens intensity: brighter when engaged/speaking + on intense moods.
        val moodBoost = when (expression) {
            FaceExpression.Angry, FaceExpression.Excited -> 1.0f
            FaceExpression.Sad, FaceExpression.Sleepy -> 0.35f
            else -> 0.65f
        }
        val lensTarget = if (privacy || eyesClosed) 0.12f else moodBoost
        val lens by animateFloatAsState(lensTarget, tween(500, easing = EaseInOutCubic), label = "lens")
        val lensColor = if (expression == FaceExpression.Angry) palette.eyeBright else palette.eyeBase

        Box(modifier = modifier.fillMaxSize()) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val w = size.width
                val h = size.height
                val cx = w * 0.5f
                val cy = h * 0.5f
                val u = (minOf(w, h) * 0.18f) * compactFraction // base unit ~ old eye radius
                val effBreath = if (frame.staticForScreenshot) 0.5f else frame.breath
                val bob = (effBreath - 0.5f) * u * 0.12f

                rotate(degrees = shape.tiltDeg * 0.5f, pivot = Offset(cx, cy)) {
                    // Helmet dome.
                    val domeTop = cy - u * 2.6f + bob
                    val domeBot = cy + u * 3.0f + bob
                    val domeHalf = u * 2.4f
                    val dome = Path().apply {
                        moveTo(cx - domeHalf, domeBot)
                        cubicTo(cx - domeHalf, domeTop, cx - domeHalf * 0.5f, domeTop - u * 0.8f, cx, domeTop - u * 0.8f)
                        cubicTo(cx + domeHalf * 0.5f, domeTop - u * 0.8f, cx + domeHalf, domeTop, cx + domeHalf, domeBot)
                        // flare out at the bottom (the shoulders of the helmet)
                        cubicTo(cx + domeHalf * 1.25f, domeBot + u * 0.4f, cx + domeHalf * 1.1f, domeBot + u * 0.9f, cx + domeHalf * 0.7f, domeBot + u * 0.9f)
                        lineTo(cx - domeHalf * 0.7f, domeBot + u * 0.9f)
                        cubicTo(cx - domeHalf * 1.1f, domeBot + u * 0.9f, cx - domeHalf * 1.25f, domeBot + u * 0.4f, cx - domeHalf, domeBot)
                        close()
                    }
                    drawPath(dome, brush = Brush.verticalGradient(
                        colors = listOf(helmetEdge, helmet),
                        startY = domeTop, endY = domeBot,
                    ))
                    drawPath(dome, color = helmetEdge, style = Stroke(width = u * 0.06f))

                    // Brow ridge — a dark angled band over the lenses.
                    val browY = cy - u * 0.5f + bob
                    val brow = Path().apply {
                        moveTo(cx - u * 1.8f, browY - u * 0.2f)
                        lineTo(cx, browY - u * 0.7f)
                        lineTo(cx + u * 1.8f, browY - u * 0.2f)
                        lineTo(cx + u * 1.8f, browY + u * 0.2f)
                        lineTo(cx, browY - u * 0.25f)
                        lineTo(cx - u * 1.8f, browY + u * 0.2f)
                        close()
                    }
                    drawPath(brow, color = Color.Black)

                    // Triangular red eye lenses.
                    val gx = gaze.x * u * 0.12f
                    drawLens(Offset(cx - u * 0.95f + gx, cy + bob), u, isLeft = true, color = lensColor, intensity = lens)
                    drawLens(Offset(cx + u * 0.95f + gx, cy + bob), u, isLeft = false, color = lensColor, intensity = lens)

                    // Vertical grille over the "nose" + mouth vents.
                    val grilleColor = Color(0xFF050607)
                    for (i in -1..1) {
                        val x = cx + i * u * 0.22f
                        drawLine(grilleColor, Offset(x, cy + u * 0.9f + bob), Offset(x, cy + u * 2.2f + bob),
                            strokeWidth = u * 0.10f, cap = StrokeCap.Round)
                    }
                    // Mouth vent grid.
                    val ventY = cy + u * 2.4f + bob
                    for (i in -2..2) {
                        val x = cx + i * u * 0.42f
                        drawLine(grilleColor, Offset(x, ventY), Offset(x, ventY + u * 0.6f),
                            strokeWidth = u * 0.14f, cap = StrokeCap.Round)
                    }
                }
            }
        }
    }

    private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawLens(
        center: Offset,
        u: Float,
        isLeft: Boolean,
        color: Color,
        intensity: Float,
    ) {
        val dir = if (isLeft) -1f else 1f
        // Angled teardrop/triangle lens: wide at the outer-top, narrow inner-bottom.
        val path = Path().apply {
            moveTo(center.x - dir * u * 0.7f, center.y - u * 0.5f)  // outer top
            lineTo(center.x + dir * u * 0.7f, center.y - u * 0.15f) // inner top
            lineTo(center.x + dir * u * 0.35f, center.y + u * 0.55f) // inner bottom
            lineTo(center.x - dir * u * 0.6f, center.y + u * 0.35f)  // outer bottom
            close()
        }
        // Dark lens housing.
        drawPath(path, color = Color(0xFF1A0606))
        // Glowing red fill.
        drawPath(path, brush = Brush.radialGradient(
            colors = listOf(
                color.copy(alpha = (0.95f * intensity).coerceIn(0f, 1f)),
                color.copy(alpha = (0.45f * intensity).coerceIn(0f, 1f)),
            ),
            center = center, radius = u,
        ))
        // Outer glow.
        drawCircle(color.copy(alpha = 0.18f * intensity), radius = u * 0.9f, center = center)
    }
}
