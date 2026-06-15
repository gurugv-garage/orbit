package dev.orbit.dock.ui.face

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.EaseInOutCubic
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope

/**
 * Robot — a fully custom face proving the [Face] interface is general (no soft
 * eyes at all): hard rectangular LED-segment eyes whose SHAPE changes per mood,
 * an antenna with a blinking tip, and a faint horizontal scanline shimmer.
 * Flat, synthy voice.
 *
 * Uses [rememberFaceFrame] for shared timing (breath bob, the blink as an LED
 * flicker, the expression tween that drives eye shape).
 */
object RobotFace : Face {
    override val id = "robot"
    override val label = "Robot"
    override val voice = VoiceProfile(pitch = 0.9f, rate = 1.0f)
    override val palette = FacePalette(
        background = Color(0xFF04080A),
        eyeBase = Color(0xFF35E0D0),     // cyan LED
        eyeBright = Color(0xFF8CFFF1),
        eyeDim = Color(0xFF14524C),
        bad = Color(0xFFFF5A4D),
        onBackground = Color(0xFFB7E9E3),
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
        val frame = rememberFaceFrame(state, expression, privacy, eyesClosed, staticForScreenshot)
        val ledColor by animateColorAsState(
            targetValue = when {
                privacy || eyesClosed -> palette.eyeDim
                expression == FaceExpression.Angry -> palette.bad
                expression == FaceExpression.Happy || expression == FaceExpression.Excited -> palette.eyeBright
                state == FaceState.Speaking || state == FaceState.Engaged -> palette.eyeBright
                else -> palette.eyeBase
            },
            animationSpec = tween(400, easing = EaseInOutCubic),
            label = "led",
        )

        Box(modifier = modifier.fillMaxSize()) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val w = size.width
                val h = size.height
                val cx = w * 0.5f
                val cy = h * 0.5f
                val u = (minOf(w, h) * 0.18f) * compactFraction
                val effBreath = if (frame.staticForScreenshot) 0.5f else frame.breath
                val bob = (effBreath - 0.5f) * u * 0.10f
                // Blink → LED brightness flicker (robots don't have lids).
                val lit = (0.5f + frame.lid * 0.5f)

                val gx = gaze.x * u * 0.18f
                val gy = gaze.y * u * 0.12f + bob
                val eyeGap = u * 1.7f
                drawLedEye(Offset(cx - eyeGap + gx, cy + gy), u, expression, ledColor, lit)
                drawLedEye(Offset(cx + eyeGap + gx, cy + gy), u, expression, ledColor, lit)

                // Mouth: a row of small LED bars; more lit when speaking.
                if (!privacy) {
                    val mBars = 5
                    val mouthY = cy + u * 2.0f + bob
                    val barW = u * 0.18f
                    val spacing = u * 0.34f
                    val active = if (state == FaceState.Speaking) (0.5f + frame.breath * 0.5f) else 0.35f
                    for (i in 0 until mBars) {
                        val x = cx + (i - (mBars - 1) / 2f) * spacing
                        val barH = u * (0.18f + active * 0.5f * (1f - kotlin.math.abs(i - 2) * 0.2f))
                        drawRoundRect(
                            color = ledColor.copy(alpha = 0.85f * lit),
                            topLeft = Offset(x - barW / 2, mouthY - barH / 2),
                            size = Size(barW, barH),
                            cornerRadius = CornerRadius(barW / 2, barW / 2),
                        )
                    }
                }

                // Antenna with a blinking tip.
                val antX = cx
                val antBase = cy - u * 2.2f + bob
                val antTip = antBase - u * 1.0f
                drawLine(palette.eyeDim, Offset(antX, antBase), Offset(antX, antTip),
                    strokeWidth = u * 0.10f, cap = StrokeCap.Round)
                val tipOn = (frame.breath > 0.5f) || frame.staticForScreenshot
                drawCircle(
                    color = if (tipOn) palette.bad else palette.eyeDim,
                    radius = u * 0.18f, center = Offset(antX, antTip),
                )
                if (tipOn) drawCircle(palette.bad.copy(alpha = 0.3f), radius = u * 0.34f, center = Offset(antX, antTip))

                // Faint scanline shimmer across the whole face.
                if (!frame.staticForScreenshot) {
                    val scanY = (frame.breath * h)
                    drawRect(
                        color = palette.eyeBright.copy(alpha = 0.04f),
                        topLeft = Offset(0f, scanY - u * 0.3f),
                        size = Size(w, u * 0.6f),
                    )
                }
            }
        }
    }

    /** A rectangular LED eye; its height/shape encodes the mood. */
    private fun DrawScope.drawLedEye(
        center: Offset,
        u: Float,
        expression: FaceExpression,
        color: Color,
        lit: Float,
    ) {
        // mood → (widthMul, heightMul, cornerMul). Happy = thin smile bar,
        // surprised = tall square, angry = downward wedge (drawn as thin top),
        // sleepy = thin flat line.
        val (wm, hm) = when (expression) {
            FaceExpression.Happy, FaceExpression.Love -> 1.2f to 0.35f
            FaceExpression.Excited, FaceExpression.Surprised -> 1.0f to 1.15f
            FaceExpression.Sleepy -> 1.1f to 0.16f
            FaceExpression.Sad, FaceExpression.Concerned -> 0.9f to 0.55f
            FaceExpression.Angry -> 1.15f to 0.45f
            else -> 1.0f to 0.8f
        }
        val ew = u * wm
        val eh = u * hm
        // Glow.
        drawRoundRect(
            color = color.copy(alpha = 0.18f * lit),
            topLeft = Offset(center.x - ew * 0.75f, center.y - eh * 0.75f),
            size = Size(ew * 1.5f, eh * 1.5f),
            cornerRadius = CornerRadius(u * 0.3f, u * 0.3f),
        )
        // Core LED.
        drawRoundRect(
            color = color.copy(alpha = lit),
            topLeft = Offset(center.x - ew / 2, center.y - eh / 2),
            size = Size(ew, eh),
            cornerRadius = CornerRadius(u * 0.18f, u * 0.18f),
        )
        // Bright inner highlight bar.
        drawRoundRect(
            color = Color.White.copy(alpha = 0.25f * lit),
            topLeft = Offset(center.x - ew * 0.35f, center.y - eh * 0.30f),
            size = Size(ew * 0.7f, eh * 0.22f),
            cornerRadius = CornerRadius(u * 0.1f, u * 0.1f),
        )
    }
}
