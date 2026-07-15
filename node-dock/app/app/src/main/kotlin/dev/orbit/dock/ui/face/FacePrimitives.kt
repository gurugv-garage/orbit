package dev.orbit.dock.ui.face

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

/**
 * Shared face-drawing kit. These were the `private` helpers + expression engine
 * inside the old monolithic FaceRenderer; extracted here so every [Face] can
 * reuse them. `internal` to the app — not a public API.
 *
 * The colour-dependent drawers take a [FacePalette] so each face renders in its
 * own colours (Aurora keeps the original DockPalette values via FacePalette's
 * defaults).
 */

// ── Expression engine ──────────────────────────────────────────────────────

/**
 * Numeric deltas an expression applies on top of base eye drawing. Tweened by
 * the animation engine ([lerpExpressionShape]) so transitions are smooth.
 */
internal data class ExpressionShape(
    val lidBottomCurve: Float = 0f,
    val lidTopCurveInner: Float = 0f,
    val eyeScaleX: Float = 1f,
    val eyeScaleY: Float = 1f,
    val lidClamp: Float = 1f,
    val pupilScale: Float = 1f,
    val tiltDeg: Float = 0f,
    val asymmetry: Float = 0f,
    val haloMul: Float = 1f,
    val cheekAlwaysOn: Boolean = false,
    val gazeYBias: Float = 0f,
    // Brows. innerY < 0 = inner end goes UP (sad/surprised), > 0 = DOWN (angry).
    val browShow: Float = 0f,
    val browInnerY: Float = 0f,    // -1..+1 (× brow gap)
    val browOuterY: Float = 0f,
    val browTilt: Float = 0f,      // degrees
    val browThick: Float = 1f,     // scale
    val browArch: Float = 0f,      // -1 flat, 0 slight arch, +1 high arch
    val mouthKind: Int = MOUTH_NONE,
    val mouthOpen: Float = 0f,     // 0..1 size scale
    val accent: Int = ACCENT_NONE,
)

internal const val MOUTH_NONE = 0
internal const val MOUTH_SMILE = 1
internal const val MOUTH_FROWN = 2
internal const val MOUTH_O = 3
internal const val MOUTH_BIG_SMILE = 4
internal const val MOUTH_FLAT = 5
internal const val MOUTH_GRIN_TEETH = 6

internal const val ACCENT_NONE = 0
internal const val ACCENT_TEAR = 1        // single drop on cheek (sad)
internal const val ACCENT_SPARKLE = 2     // stars around face (excited)
internal const val ACCENT_HEART = 3       // pair of hearts (love)
internal const val ACCENT_ANGER = 4       // # mark beside head (angry)
internal const val ACCENT_ZZZ = 5         // sleepy z's
internal const val ACCENT_SWEAT = 6       // single sweat drop (concerned)
internal const val ACCENT_QUESTION = 7    // ? mark beside head (curious)

/**
 * Linearly interpolate every numeric field. Discrete fields (mouthKind, accent,
 * cheekAlwaysOn) snap to the target's value at t=0.5 — categorical, not
 * blendable; the visual flip hides under the eye/brow motion.
 */
internal fun lerpExpressionShape(a: ExpressionShape, b: ExpressionShape, t: Float): ExpressionShape {
    val u = t.coerceIn(0f, 1f)
    fun l(x: Float, y: Float) = x + (y - x) * u
    return ExpressionShape(
        lidBottomCurve = l(a.lidBottomCurve, b.lidBottomCurve),
        lidTopCurveInner = l(a.lidTopCurveInner, b.lidTopCurveInner),
        eyeScaleX = l(a.eyeScaleX, b.eyeScaleX),
        eyeScaleY = l(a.eyeScaleY, b.eyeScaleY),
        lidClamp = l(a.lidClamp, b.lidClamp),
        pupilScale = l(a.pupilScale, b.pupilScale),
        tiltDeg = l(a.tiltDeg, b.tiltDeg),
        asymmetry = l(a.asymmetry, b.asymmetry),
        haloMul = l(a.haloMul, b.haloMul),
        cheekAlwaysOn = if (u < 0.5f) a.cheekAlwaysOn else b.cheekAlwaysOn,
        gazeYBias = l(a.gazeYBias, b.gazeYBias),
        browShow = l(a.browShow, b.browShow),
        browInnerY = l(a.browInnerY, b.browInnerY),
        browOuterY = l(a.browOuterY, b.browOuterY),
        browTilt = l(a.browTilt, b.browTilt),
        browThick = l(a.browThick, b.browThick),
        browArch = l(a.browArch, b.browArch),
        mouthKind = if (u < 0.5f) a.mouthKind else b.mouthKind,
        mouthOpen = l(a.mouthOpen, b.mouthOpen),
        accent = if (u < 0.5f) a.accent else b.accent,
    )
}

internal fun shapeFor(e: FaceExpression): ExpressionShape = when (e) {
    FaceExpression.Neutral -> ExpressionShape(
        browShow = 0.6f, browArch = 0.2f,
    )
    FaceExpression.Happy -> ExpressionShape(
        lidBottomCurve = 1.6f, lidClamp = 0.55f,
        cheekAlwaysOn = true, haloMul = 1.35f,
        browShow = 0.9f, browArch = 1f, browOuterY = -0.25f, browInnerY = -0.1f,
        mouthKind = MOUTH_SMILE, mouthOpen = 1f,
    )
    FaceExpression.Curious -> ExpressionShape(
        tiltDeg = 16f, asymmetry = 0.4f, pupilScale = 1.4f, eyeScaleY = 1.15f,
        browShow = 1f, browInnerY = -0.5f, browArch = 0.6f, browTilt = 8f,
        mouthKind = MOUTH_FLAT, mouthOpen = 0.4f,
        accent = ACCENT_QUESTION,
    )
    FaceExpression.Concerned -> ExpressionShape(
        eyeScaleX = 1.1f, eyeScaleY = 1.1f, pupilScale = 1.25f, haloMul = 0.6f,
        gazeYBias = 0.05f,
        // Inner brows UP (negative), like Sad's -0.7 — the universal WORRY brow.
        // This was +0.55 (inner brows DOWN), which is the ANGER brow: photographed
        // on the dock, `concerned` read as annoyed even after its tear became a
        // sweat bead. Softer than Sad so it's worry, not grief.
        browShow = 1f, browInnerY = -0.45f, browTilt = -6f, browThick = 1.15f,
        mouthKind = MOUTH_FROWN, mouthOpen = 0.85f,
        accent = ACCENT_SWEAT,
    )
    FaceExpression.Surprised -> ExpressionShape(
        eyeScaleX = 1.55f, eyeScaleY = 1.55f, pupilScale = 0.65f, haloMul = 1.45f,
        browShow = 1f, browInnerY = -0.85f, browOuterY = -0.85f, browArch = 1.2f, browThick = 1.1f,
        mouthKind = MOUTH_O, mouthOpen = 1.1f,
    )
    FaceExpression.Sleepy -> ExpressionShape(
        lidClamp = 0.18f, haloMul = 0.4f, pupilScale = 0.8f, gazeYBias = 0.15f,
        browShow = 0.45f, browArch = -0.5f, browOuterY = 0.25f,
        mouthKind = MOUTH_FLAT, mouthOpen = 0.35f,
        accent = ACCENT_ZZZ,
    )
    FaceExpression.Wink -> ExpressionShape(
        lidBottomCurve = 1.2f, cheekAlwaysOn = true, haloMul = 1.15f,
        browShow = 0.85f, browArch = 0.6f, browOuterY = -0.2f,
        mouthKind = MOUTH_SMILE, mouthOpen = 0.95f,
    )
    FaceExpression.Sad -> ExpressionShape(
        lidTopCurveInner = -0.9f, haloMul = 0.4f, gazeYBias = 0.42f,
        pupilScale = 1.05f, eyeScaleY = 0.85f, lidClamp = 0.78f,
        browShow = 1f, browInnerY = -0.7f, browTilt = -10f, browArch = -0.2f,
        mouthKind = MOUTH_FROWN, mouthOpen = 0.9f,
        accent = ACCENT_TEAR,
    )
    FaceExpression.Excited -> ExpressionShape(
        eyeScaleX = 1.3f, eyeScaleY = 1.4f, haloMul = 1.55f, pupilScale = 1.6f,
        cheekAlwaysOn = true,
        browShow = 1f, browInnerY = -0.45f, browArch = 1.1f, browOuterY = -0.4f, browThick = 1.05f,
        mouthKind = MOUTH_BIG_SMILE, mouthOpen = 1.1f,
        accent = ACCENT_SPARKLE,
    )
    FaceExpression.Angry -> ExpressionShape(
        lidTopCurveInner = 1.3f, lidClamp = 0.42f, haloMul = 0.45f,
        pupilScale = 0.55f, eyeScaleY = 0.72f, eyeScaleX = 1.05f,
        browShow = 1f, browInnerY = 0.7f, browTilt = -18f, browThick = 1.4f, browArch = -0.3f,
        mouthKind = MOUTH_GRIN_TEETH, mouthOpen = 0.95f,
        accent = ACCENT_ANGER,
    )
    FaceExpression.Love -> ExpressionShape(
        lidBottomCurve = 0.85f, cheekAlwaysOn = true, haloMul = 1.35f, pupilScale = 1.45f,
        browShow = 0.85f, browArch = 0.85f, browOuterY = -0.2f,
        mouthKind = MOUTH_SMILE, mouthOpen = 0.8f,
        accent = ACCENT_HEART,
    )
}

/** State→colour for eye-based faces, parameterised by the face's [palette]. */
internal fun currentEyeColor(
    state: FaceState,
    expression: FaceExpression,
    privacy: Boolean,
    palette: FacePalette,
): Color = when {
    privacy -> palette.eyeDim
    expression == FaceExpression.Sleepy -> palette.eyeDim
    expression == FaceExpression.Sad -> palette.eyeDim
    expression == FaceExpression.Angry -> palette.bad
    expression == FaceExpression.Excited -> palette.eyeBright
    expression == FaceExpression.Happy -> palette.eyeBright
    state == FaceState.Speaking -> palette.eyeBright
    state == FaceState.Engaged -> palette.eyeBright
    else -> palette.eyeBase
}

// ── Glow / cheeks ───────────────────────────────────────────────────────────

internal fun DrawScope.drawHalo(center: Offset, radius: Float, intensity: Float, glow: Color) {
    val brush = Brush.radialGradient(
        colors = listOf(
            glow.copy(alpha = (0.30f * intensity).coerceIn(0f, 1f)),
            glow.copy(alpha = (0.10f * intensity).coerceIn(0f, 1f)),
            Color.Transparent,
        ),
        center = center,
        radius = radius,
    )
    drawCircle(brush = brush, radius = radius, center = center)
}

internal fun DrawScope.drawCheek(center: Offset, radius: Float, intensity: Float, cheek: Color) {
    val brush = Brush.radialGradient(
        colors = listOf(
            cheek.copy(alpha = 0.35f * intensity),
            cheek.copy(alpha = 0.12f * intensity),
            Color.Transparent,
        ),
        center = center,
        radius = radius,
    )
    drawCircle(brush = brush, radius = radius, center = center)
}

// ── Eye ─────────────────────────────────────────────────────────────────────

/**
 * Draws one eye. [slitPupil] squeezes the pupil horizontally into a reptilian /
 * feline vertical slit (used by cat-likes / dragon); default is a round pupil.
 */
@Suppress("LongParameterList")
internal fun DrawScope.drawEye(
    center: Offset,
    radius: Float,
    lidOpen: Float,
    gazeX: Float,
    gazeY: Float,
    pupilDilate: Float,
    color: Color,
    eyeScaleX: Float,
    eyeScaleY: Float,
    lidBottomCurve: Float,
    lidTopCurveInner: Float,
    isLeft: Boolean,
    expression: FaceExpression,
    palette: FacePalette,
    slitPupil: Boolean = false,
) {
    val verticalScale = lidOpen.coerceIn(0.02f, 1f)
    val rx = radius * eyeScaleX
    val ry = radius * eyeScaleY
    val eyeHeight = ry * 2f * verticalScale

    val body = buildEyePath(
        center = center,
        rx = rx,
        halfH = eyeHeight / 2f,
        lidBottomCurve = lidBottomCurve,
        lidTopCurveInner = lidTopCurveInner,
        isLeft = isLeft,
    )

    val bodyBrush = Brush.radialGradient(
        colors = listOf(
            color.copy(alpha = 0.96f),
            color.copy(alpha = 0.78f),
        ),
        center = center,
        radius = rx.coerceAtLeast(1f),
    )
    drawPath(path = body, brush = bodyBrush)

    if (lidOpen > 0.22f) {
        val pupilCenter = Offset(center.x + gazeX, center.y + gazeY)
        val pupilR = radius * 0.42f * pupilDilate
        if (expression == FaceExpression.Love) {
            drawPath(
                path = heartPath(pupilCenter, pupilR * 2.2f),
                color = palette.cheek,
            )
        } else if (slitPupil) {
            // Vertical slit: tall, narrow ellipse.
            val slitW = pupilR * 0.42f
            val slitH = pupilR * 2.0f
            drawOval(
                color = palette.pupil,
                topLeft = Offset(pupilCenter.x - slitW, pupilCenter.y - slitH),
                size = Size(slitW * 2f, slitH * 2f),
            )
        } else {
            val pupilColor = if (expression == FaceExpression.Angry) {
                Color(red = 0.35f, green = 0f, blue = 0f, alpha = 1f)
            } else {
                palette.pupil
            }
            drawCircle(
                color = pupilColor,
                radius = pupilR,
                center = pupilCenter,
            )
            if (expression == FaceExpression.Excited) {
                drawSparkle(pupilCenter, pupilR * 1.4f, palette.accent.copy(alpha = 0.9f))
            }
        }
        val catchScale = (lidOpen - 0.22f) / 0.78f
        drawCircle(
            color = palette.catchlight.copy(alpha = 0.98f * catchScale),
            radius = radius * 0.13f,
            center = Offset(
                pupilCenter.x - radius * 0.13f,
                pupilCenter.y - radius * 0.16f,
            ),
        )
        drawCircle(
            color = palette.catchlight.copy(alpha = 0.55f * catchScale),
            radius = radius * 0.06f,
            center = Offset(
                pupilCenter.x + radius * 0.10f,
                pupilCenter.y + radius * 0.14f,
            ),
        )
    }
}

/**
 * Eye outline:
 *   - lidBottomCurve > 0 lifts the bottom edge (smiling ^ eye shape).
 *   - lidTopCurveInner > 0 pulls top edge down on the inner corner (angry);
 *     < 0 lifts the inner corner (sad).
 *   - "Inner" = side facing the nose: right side of left eye, left side of right.
 */
internal fun buildEyePath(
    center: Offset,
    rx: Float,
    halfH: Float,
    lidBottomCurve: Float,
    lidTopCurveInner: Float,
    isLeft: Boolean,
): Path {
    val k = 0.5523f
    val cx = center.x
    val cy = center.y
    val top = cy - halfH
    val bot = cy + halfH
    val left = cx - rx
    val right = cx + rx

    val lift = halfH * 0.85f * lidBottomCurve.coerceIn(0f, 1.8f)
    val effBot = bot - lift

    val innerDelta = halfH * 0.9f * lidTopCurveInner
    val (topLeftY, topRightY) = if (isLeft) {
        top to (top + innerDelta)
    } else {
        (top + innerDelta) to top
    }

    val path = Path()
    val topMidY = (topLeftY + topRightY) / 2f
    path.moveTo(cx, topMidY)
    path.cubicTo(
        cx + rx * k, topMidY,
        right, topRightY + halfH * (1f - k),
        right, cy,
    )
    path.cubicTo(
        right, cy + (effBot - cy) * k,
        cx + rx * k, effBot,
        cx, effBot,
    )
    path.cubicTo(
        cx - rx * k, effBot,
        left, cy + (effBot - cy) * k,
        left, cy,
    )
    path.cubicTo(
        left, topLeftY + halfH * (1f - k),
        cx - rx * k, topMidY,
        cx, topMidY,
    )
    path.close()
    return path
}

internal fun heartPath(center: Offset, size: Float): Path {
    val w = size
    val h = size
    val cx = center.x
    val cy = center.y
    val path = Path()
    path.moveTo(cx, cy + h * 0.45f)
    path.cubicTo(
        cx - w * 0.9f, cy + h * 0.05f,
        cx - w * 0.55f, cy - h * 0.6f,
        cx, cy - h * 0.15f,
    )
    path.cubicTo(
        cx + w * 0.55f, cy - h * 0.6f,
        cx + w * 0.9f, cy + h * 0.05f,
        cx, cy + h * 0.45f,
    )
    path.close()
    return path
}

// ── Wink / mouth / brow ──────────────────────────────────────────────────────

internal fun DrawScope.drawWinkedEye(center: Offset, rx: Float, ry: Float, color: Color) {
    val w = (ry * 0.45f).coerceAtLeast(4f)
    val path = Path().apply {
        moveTo(center.x - rx, center.y + ry * 0.3f)
        quadraticTo(center.x, center.y - ry * 1.1f, center.x + rx, center.y + ry * 0.3f)
    }
    drawPath(path, color, style = Stroke(width = w, cap = StrokeCap.Round, join = StrokeJoin.Round))
}

internal fun DrawScope.drawMouth(center: Offset, size: Float, kind: Int, color: Color, cheek: Color) {
    val stroke = Stroke(
        width = (size * 0.18f).coerceAtLeast(3f),
        cap = StrokeCap.Round,
        join = StrokeJoin.Round,
    )
    val w = size * 1.6f
    val h = size
    when (kind) {
        MOUTH_SMILE -> {
            val path = Path().apply {
                moveTo(center.x - w / 2, center.y)
                quadraticTo(center.x, center.y + h * 0.9f, center.x + w / 2, center.y)
            }
            drawPath(path, color, style = stroke)
        }
        MOUTH_FROWN -> {
            val path = Path().apply {
                moveTo(center.x - w / 2, center.y + h * 0.4f)
                quadraticTo(center.x, center.y - h * 0.5f, center.x + w / 2, center.y + h * 0.4f)
            }
            drawPath(path, color, style = stroke)
        }
        MOUTH_O -> {
            drawCircle(color = color, radius = h * 0.55f, center = center, style = stroke)
        }
        MOUTH_BIG_SMILE -> {
            val path = Path().apply {
                moveTo(center.x - w / 2, center.y)
                lineTo(center.x + w / 2, center.y)
                cubicTo(
                    center.x + w / 2, center.y + h * 0.4f,
                    center.x + w / 3, center.y + h * 1.1f,
                    center.x, center.y + h * 1.1f,
                )
                cubicTo(
                    center.x - w / 3, center.y + h * 1.1f,
                    center.x - w / 2, center.y + h * 0.4f,
                    center.x - w / 2, center.y,
                )
                close()
            }
            drawPath(path, color)
            val tonguePath = Path().apply {
                addOval(
                    Rect(
                        offset = Offset(center.x - w * 0.32f, center.y + h * 0.45f),
                        size = Size(w * 0.64f, h * 0.85f),
                    ),
                )
            }
            drawPath(tonguePath, cheek)
        }
        MOUTH_FLAT -> {
            drawLine(
                color = color,
                start = Offset(center.x - w / 2, center.y),
                end = Offset(center.x + w / 2, center.y),
                strokeWidth = stroke.width,
                cap = StrokeCap.Round,
            )
        }
        MOUTH_GRIN_TEETH -> {
            val mouthH = h * 0.7f
            val outline = Path().apply {
                moveTo(center.x - w / 2, center.y - mouthH * 0.2f)
                lineTo(center.x + w / 2, center.y - mouthH * 0.2f)
                lineTo(center.x + w / 2 * 0.85f, center.y + mouthH * 0.55f)
                lineTo(center.x - w / 2 * 0.85f, center.y + mouthH * 0.55f)
                close()
            }
            drawPath(outline, color)
            val toothColor = Color(0xFFF3F8FB)
            val zig = Path().apply {
                val baseY = center.y - mouthH * 0.05f
                val tipY = center.y + mouthH * 0.45f
                val steps = 5
                moveTo(center.x - w / 2 * 0.78f, baseY)
                for (i in 0 until steps) {
                    val x1 = center.x - w / 2 * 0.78f + (w * 0.78f) * (i + 0.5f) / steps
                    val x2 = center.x - w / 2 * 0.78f + (w * 0.78f) * (i + 1f) / steps
                    lineTo(x1, tipY)
                    lineTo(x2, baseY)
                }
                close()
            }
            drawPath(zig, toothColor)
        }
    }
}

@Suppress("LongParameterList")
internal fun DrawScope.drawBrow(
    eyeCenter: Offset,
    eyeRx: Float,
    eyeRy: Float,
    innerY: Float,
    outerY: Float,
    tilt: Float,
    thick: Float,
    arch: Float,
    isLeft: Boolean,
    color: Color,
) {
    val gap = eyeRy * 0.55f
    val baselineY = eyeCenter.y - eyeRy - gap
    val halfLen = eyeRx * 0.9f
    val tiltOff = (halfLen * kotlin.math.tan(Math.toRadians(tilt.toDouble())).toFloat())

    val innerX = if (isLeft) eyeCenter.x + halfLen else eyeCenter.x - halfLen
    val outerX = if (isLeft) eyeCenter.x - halfLen else eyeCenter.x + halfLen

    val innerEndY = baselineY + innerY * eyeRy + (if (isLeft) tiltOff else -tiltOff)
    val outerEndY = baselineY + outerY * eyeRy - (if (isLeft) tiltOff else -tiltOff)

    val midX = (innerX + outerX) / 2f
    val midY = (innerEndY + outerEndY) / 2f - arch * eyeRy * 0.45f

    val path = Path().apply {
        moveTo(outerX, outerEndY)
        quadraticTo(midX, midY, innerX, innerEndY)
    }
    drawPath(
        path = path,
        color = color,
        style = Stroke(width = thick.coerceAtLeast(2f), cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
}

// ── Accents ──────────────────────────────────────────────────────────────────

internal fun DrawScope.drawAccent(
    kind: Int,
    leftEye: Offset,
    rightEye: Offset,
    eyeR: Float,
    palette: FacePalette,
) {
    when (kind) {
        ACCENT_TEAR -> {
            val c = Offset(rightEye.x + eyeR * 0.4f, rightEye.y + eyeR * 1.3f)
            drawTear(c, eyeR * 0.35f, palette.eyeBright.copy(alpha = 0.85f))
        }
        ACCENT_SPARKLE -> {
            val positions = listOf(
                Offset(leftEye.x - eyeR * 1.2f, leftEye.y - eyeR * 0.7f) to eyeR * 0.38f,
                Offset(rightEye.x + eyeR * 1.2f, rightEye.y - eyeR * 0.4f) to eyeR * 0.28f,
                Offset(leftEye.x - eyeR * 1.5f, leftEye.y + eyeR * 0.9f) to eyeR * 0.22f,
                Offset(rightEye.x + eyeR * 0.8f, rightEye.y + eyeR * 1.4f) to eyeR * 0.25f,
            )
            for ((p, s) in positions) drawSparkle(p, s, Color(0xFFFFE9A6))
        }
        ACCENT_HEART -> {
            drawPath(
                heartPath(Offset(leftEye.x - eyeR * 1.7f, leftEye.y - eyeR * 0.4f), eyeR * 0.55f),
                color = palette.cheek,
            )
            drawPath(
                heartPath(Offset(rightEye.x + eyeR * 1.5f, rightEye.y + eyeR * 0.6f), eyeR * 0.35f),
                color = palette.cheek.copy(alpha = 0.85f),
            )
        }
        ACCENT_ANGER -> {
            val c = Offset(leftEye.x - eyeR * 1.6f, leftEye.y - eyeR * 1.5f)
            drawAngerMark(c, eyeR * 0.45f, palette.bad)
        }
        ACCENT_ZZZ -> {
            val color = palette.onBackground.copy(alpha = 0.85f)
            drawZ(Offset(rightEye.x + eyeR * 1.1f, rightEye.y - eyeR * 1.6f), eyeR * 0.35f, color)
            drawZ(Offset(rightEye.x + eyeR * 1.6f, rightEye.y - eyeR * 2.4f), eyeR * 0.45f, color)
            drawZ(Offset(rightEye.x + eyeR * 2.2f, rightEye.y - eyeR * 3.2f), eyeR * 0.55f, color)
        }
        ACCENT_SWEAT -> {
            // A sweat BEAD, not a tear. These used to be the same drawTear call in
            // the same eyeBright colour, differing only in position/size — so
            // `concerned` (the ONLY negative face the brain actually sends: 64 of
            // 805 inline tags; `sad`/`angry` never appear) rendered as CRYING.
            // A bead reads as pressure: round, sitting high beside the temple,
            // clear of the eye — a tear falls FROM the eye, this never touches it.
            val c = Offset(rightEye.x + eyeR * 1.75f, rightEye.y - eyeR * 1.15f)
            drawSweatBead(c, eyeR * 0.3f, palette.eyeBright.copy(alpha = 0.75f))
        }
        ACCENT_QUESTION -> {
            val c = Offset(rightEye.x + eyeR * 1.6f, rightEye.y - eyeR * 1.5f)
            drawQuestion(c, eyeR * 0.7f, palette.accent)
        }
    }
}

internal fun DrawScope.drawTear(center: Offset, size: Float, color: Color) {
    val path = Path().apply {
        moveTo(center.x, center.y - size)
        cubicTo(
            center.x + size * 0.85f, center.y - size * 0.2f,
            center.x + size * 0.85f, center.y + size * 0.7f,
            center.x, center.y + size * 0.85f,
        )
        cubicTo(
            center.x - size * 0.85f, center.y + size * 0.7f,
            center.x - size * 0.85f, center.y - size * 0.2f,
            center.x, center.y - size,
        )
        close()
    }
    drawPath(path, color)
    drawCircle(
        Color.White.copy(alpha = 0.5f),
        radius = size * 0.18f,
        center = Offset(center.x - size * 0.25f, center.y + size * 0.1f),
    )
}

/**
 * A sweat BEAD (anxiety), deliberately the visual opposite of [drawTear] (grief).
 * The tear is a POINTED drop with the point UP — it reads as falling. The bead is
 * ROUND with only a slight peak, sitting proud of the skin — it reads as beading
 * up under pressure. Keep them distinguishable at a glance and across face
 * styles: `concerned` is the only negative expression the brain sends in
 * practice, and it must never read as crying.
 */
internal fun DrawScope.drawSweatBead(center: Offset, size: Float, color: Color) {
    // NEAR-CIRCULAR body + a small top nub. Four arcs (K = the standard
    // circle-from-beziers constant), NOT two long curves — the first cut of this
    // used two mirrored cubics and rendered as a slightly smaller TEAR: bounds
    // ratio w/h 0.63 vs the tear's 0.69, i.e. it was MORE pointed, not less.
    // Rendered both offline to compare: this one measures 1.16 (round). If you
    // change these numbers, render them — the intent is not visible in the math.
    val k = 0.5523f * size
    val path = Path().apply {
        moveTo(center.x, center.y - size * 0.72f)          // small peak, not a point
        cubicTo(
            center.x + k * 0.92f, center.y - size * 0.60f,
            center.x + size, center.y - k * 0.30f,
            center.x + size, center.y + size * 0.06f,
        )
        cubicTo(
            center.x + size, center.y + size * 0.06f + k,
            center.x + k, center.y + size,
            center.x, center.y + size,                      // round bottom
        )
        cubicTo(
            center.x - k, center.y + size,
            center.x - size, center.y + size * 0.06f + k,
            center.x - size, center.y + size * 0.06f,
        )
        cubicTo(
            center.x - size, center.y - k * 0.30f,
            center.x - k * 0.92f, center.y - size * 0.60f,
            center.x, center.y - size * 0.72f,
        )
        close()
    }
    drawPath(path, color)
    // Bright catchlight, high and offset — the wet, beaded look.
    drawCircle(
        Color.White.copy(alpha = 0.7f),
        radius = size * 0.24f,
        center = Offset(center.x - size * 0.28f, center.y - size * 0.05f),
    )
}

internal fun DrawScope.drawSparkle(center: Offset, size: Float, color: Color) {
    val path = Path().apply {
        moveTo(center.x, center.y - size)
        cubicTo(center.x + size * 0.3f, center.y - size * 0.3f, center.x + size * 0.3f, center.y - size * 0.3f, center.x + size, center.y)
        cubicTo(center.x + size * 0.3f, center.y + size * 0.3f, center.x + size * 0.3f, center.y + size * 0.3f, center.x, center.y + size)
        cubicTo(center.x - size * 0.3f, center.y + size * 0.3f, center.x - size * 0.3f, center.y + size * 0.3f, center.x - size, center.y)
        cubicTo(center.x - size * 0.3f, center.y - size * 0.3f, center.x - size * 0.3f, center.y - size * 0.3f, center.x, center.y - size)
        close()
    }
    drawPath(path, color)
}

internal fun DrawScope.drawAngerMark(center: Offset, size: Float, color: Color) {
    val w = size * 0.18f
    val angles = listOf(-90f, -30f, 30f, 90f, 150f, 210f)
    for (a in angles) {
        val rad = Math.toRadians(a.toDouble())
        val sx = center.x + (kotlin.math.cos(rad) * size * 0.35f).toFloat()
        val sy = center.y + (kotlin.math.sin(rad) * size * 0.35f).toFloat()
        val ex = center.x + (kotlin.math.cos(rad) * size).toFloat()
        val ey = center.y + (kotlin.math.sin(rad) * size).toFloat()
        drawLine(color, Offset(sx, sy), Offset(ex, ey), strokeWidth = w, cap = StrokeCap.Round)
    }
}

internal fun DrawScope.drawZ(center: Offset, size: Float, color: Color) {
    val w = size
    val h = size
    val path = Path().apply {
        moveTo(center.x - w / 2, center.y - h / 2)
        lineTo(center.x + w / 2, center.y - h / 2)
        lineTo(center.x - w / 2, center.y + h / 2)
        lineTo(center.x + w / 2, center.y + h / 2)
    }
    drawPath(path, color, style = Stroke(width = size * 0.18f, cap = StrokeCap.Round, join = StrokeJoin.Round))
}

internal fun DrawScope.drawQuestion(center: Offset, size: Float, color: Color) {
    val stroke = Stroke(width = size * 0.22f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    val r = size * 0.35f
    val loopCenter = Offset(center.x, center.y - size * 0.25f)
    val path = Path().apply {
        moveTo(loopCenter.x - r, loopCenter.y - r * 0.2f)
        cubicTo(loopCenter.x - r, loopCenter.y - r * 1.5f, loopCenter.x + r, loopCenter.y - r * 1.5f, loopCenter.x + r, loopCenter.y - r * 0.2f)
        cubicTo(loopCenter.x + r, loopCenter.y + r * 0.7f, loopCenter.x, loopCenter.y + r * 0.8f, loopCenter.x, loopCenter.y + r * 1.2f)
    }
    drawPath(path, color, style = stroke)
    drawCircle(color, radius = size * 0.12f, center = Offset(center.x, center.y + size * 0.55f))
}
