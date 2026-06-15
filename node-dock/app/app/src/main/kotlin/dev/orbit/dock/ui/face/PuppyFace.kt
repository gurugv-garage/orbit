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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

/**
 * Puppy — a clean cartoon dog, modelled on the proportions of the dog emoji
 * (round cream face, brown floppy ears at the top corners, dark eyes, dark nose,
 * mouth + tongue below) but fully DRAWN so the eyes are aligned to the face and
 * the MOUTH ANIMATES while speaking (frame.mouthChatter). Reuses [drawEye] +
 * [shapeFor] so the eyes blink + emote per mood. Eager, light voice.
 */
object PuppyFace : Face {
    override val id = "puppy"
    override val label = "Puppy"
    override val voice = VoiceProfile(pitch = 1.32f, rate = 1.12f)
    override val palette = FacePalette(
        background = Color(0xFF160F08),
        eyeBase = Color(0xFF161616),
        eyeBright = Color(0xFF222222),
        eyeDim = Color(0xFF161616),
        pupil = Color(0xFF000000),
        catchlight = Color(0xFFFFFFFF),
        cheek = Color(0xFFE89AA0),
    )

    private val faceCream = Color(0xFFF4E2C0)   // muzzle / lower face
    private val faceTan = Color(0xFFE3B877)     // upper face / forehead
    private val earColor = Color(0xFF8A5A33)    // brown floppy ears
    private val earInner = Color(0xFF6E4528)
    private val nose = Color(0xFF241712)
    private val tongue = Color(0xFFEE7E96)

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
        val eyeColor by animateColorAsState(
            targetValue = if (privacy || eyesClosed) palette.eyeDim else palette.eyeBase,
            animationSpec = tween(400, easing = EaseInOutCubic), label = "puppy-eye",
        )
        val tongueOut = !privacy && (state == FaceState.Speaking ||
            expression == FaceExpression.Happy || expression == FaceExpression.Excited ||
            expression == FaceExpression.Love)

        Box(modifier = modifier.fillMaxSize()) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val w = size.width
                val h = size.height
                val cx = w * 0.5f
                val cy = h * 0.5f
                val u = (minOf(w, h) * 0.165f) * compactFraction
                val effBreath = if (frame.staticForScreenshot) 0.5f else frame.breath
                val r = u * (0.97f + effBreath * 0.05f)

                // ── Ears: rounded brown floppy ears at the top corners ──
                drawEar(cx, cy, u, isLeft = true)
                drawEar(cx, cy, u, isLeft = false)

                // ── Head: a round face. Tan upper, cream lower (muzzle). ──
                val headR = u * 2.45f
                drawCircle(faceTan, radius = headR, center = Offset(cx, cy))
                // Cream muzzle area: a wide oval over the lower half.
                drawOval(
                    color = faceCream,
                    topLeft = Offset(cx - headR * 0.82f, cy - u * 0.15f),
                    size = Size(headR * 1.64f, headR * 1.15f),
                )

                // ── Eyes: aligned on the face, round, no brows ──
                val eyeGap = u * 0.92f
                val eyeY = cy - u * 0.5f
                val eyeR = u * 0.5f
                val leftC = Offset(cx - eyeGap, eyeY)
                val rightC = Offset(cx + eyeGap, eyeY)
                val gx = gaze.x * eyeR * 0.3f + frame.driftX * 0.45f
                val gy = gaze.y * eyeR * 0.3f + frame.driftY * 0.45f + shape.gazeYBias * eyeR
                val lid = frame.lid.coerceAtMost(shape.lidClamp)
                drawEye(
                    center = leftC, radius = eyeR, lidOpen = lid, gazeX = gx, gazeY = gy,
                    pupilDilate = frame.pupilDilate * shape.pupilScale * 1.2f, color = eyeColor,
                    eyeScaleX = shape.eyeScaleX, eyeScaleY = shape.eyeScaleY,
                    lidBottomCurve = shape.lidBottomCurve, lidTopCurveInner = shape.lidTopCurveInner,
                    isLeft = true, expression = expression, palette = palette,
                )
                drawEye(
                    center = rightC, radius = eyeR, lidOpen = lid, gazeX = gx, gazeY = gy,
                    pupilDilate = frame.pupilDilate * shape.pupilScale * 1.2f, color = eyeColor,
                    eyeScaleX = shape.eyeScaleX, eyeScaleY = shape.eyeScaleY,
                    lidBottomCurve = shape.lidBottomCurve, lidTopCurveInner = shape.lidTopCurveInner,
                    isLeft = false, expression = expression, palette = palette,
                )

                if (!privacy) {
                    // ── Nose: rounded dark blob, centred below the eyes ──
                    val noseC = Offset(cx, cy + u * 0.55f)
                    drawOval(
                        color = nose,
                        topLeft = Offset(noseC.x - u * 0.42f, noseC.y - u * 0.3f),
                        size = Size(u * 0.84f, u * 0.62f),
                    )
                    drawCircle(Color.White.copy(alpha = 0.45f), radius = u * 0.11f,
                        center = Offset(noseC.x - u * 0.13f, noseC.y - u * 0.06f))

                    // ── Mouth: philtrum + ∪∪ ; OPENS while speaking (chatter) ──
                    val mTop = noseC.y + u * 0.32f
                    val open = frame.mouthChatter * u * 0.85f   // talking gape
                    drawLine(nose, Offset(cx, mTop), Offset(cx, mTop + u * 0.3f),
                        strokeWidth = u * 0.08f, cap = StrokeCap.Round)

                    if (open > u * 0.06f) {
                        // Open mouth: a dark rounded cavity that grows with chatter.
                        val mouth = Path().apply {
                            moveTo(cx - u * 0.8f, mTop + u * 0.28f)
                            quadraticTo(cx, mTop + u * 0.45f, cx + u * 0.8f, mTop + u * 0.28f)
                            quadraticTo(cx + u * 0.5f, mTop + u * 0.28f + open, cx, mTop + u * 0.28f + open)
                            quadraticTo(cx - u * 0.5f, mTop + u * 0.28f + open, cx - u * 0.8f, mTop + u * 0.28f)
                            close()
                        }
                        drawPath(mouth, nose)
                        // tongue inside the open mouth
                        drawOval(
                            color = tongue,
                            topLeft = Offset(cx - u * 0.4f, mTop + u * 0.28f + open * 0.35f),
                            size = Size(u * 0.8f, open * 0.8f),
                        )
                    } else {
                        // Closed mouth: classic ∪∪ smile (+ tongue when happy).
                        if (tongueOut) {
                            val tip = mTop + u * 0.35f
                            val t = Path().apply {
                                moveTo(cx - u * 0.26f, tip)
                                cubicTo(cx - u * 0.36f, tip + u * 0.85f, cx + u * 0.36f, tip + u * 0.85f, cx + u * 0.26f, tip)
                                close()
                            }
                            drawPath(t, tongue)
                            drawLine(Color(0xFFC85A70), Offset(cx, tip + u * 0.12f), Offset(cx, tip + u * 0.62f),
                                strokeWidth = u * 0.045f, cap = StrokeCap.Round)
                        }
                        val smile = Path().apply {
                            moveTo(cx, mTop + u * 0.3f)
                            quadraticTo(cx - u * 0.55f, mTop + u * 0.45f, cx - u * 0.85f, mTop + u * 0.05f)
                            moveTo(cx, mTop + u * 0.3f)
                            quadraticTo(cx + u * 0.55f, mTop + u * 0.45f, cx + u * 0.85f, mTop + u * 0.05f)
                        }
                        drawPath(smile, nose, style = Stroke(width = u * 0.08f, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    }

                    if (frame.targetShape.accent != ACCENT_NONE) {
                        drawAccent(frame.targetShape.accent, leftC, rightC, eyeR, palette.copy(
                            eyeBright = Color(0xFFBFD8FF), accent = Color(0xFFFFD86B), cheek = tongue,
                            bad = Color(0xFFFF6B5C), onBackground = Color(0xFFE8D8C2),
                        ))
                    }
                }
            }
        }
    }

    /** A rounded brown floppy ear at the top-corner of the head, hanging down. */
    private fun DrawScope.drawEar(cx: Float, cy: Float, u: Float, isLeft: Boolean) {
        val dir = if (isLeft) -1f else 1f
        val topX = cx + dir * u * 1.7f
        val topY = cy - u * 1.95f
        val ear = Path().apply {
            moveTo(topX, topY)
            // bulge out and hang down to a rounded tip
            cubicTo(
                topX + dir * u * 1.35f, topY + u * 0.1f,
                topX + dir * u * 1.5f, topY + u * 2.3f,
                topX + dir * u * 0.7f, topY + u * 3.1f,
            )
            // rounded bottom, back up the inner edge to the head
            cubicTo(
                topX + dir * u * 0.15f, topY + u * 3.6f,
                topX - dir * u * 0.55f, topY + u * 2.2f,
                topX - dir * u * 0.35f, topY + u * 0.9f,
            )
            cubicTo(
                topX - dir * u * 0.25f, topY + u * 0.35f,
                topX - dir * u * 0.1f, topY + u * 0.05f,
                topX, topY,
            )
            close()
        }
        drawPath(ear, earColor)
        // inner-ear shade
        drawPath(ear, earInner.copy(alpha = 0.35f))
    }
}
