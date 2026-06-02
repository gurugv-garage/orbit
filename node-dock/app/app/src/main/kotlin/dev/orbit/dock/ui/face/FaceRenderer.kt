package dev.orbit.dock.ui.face

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseInOutCubic
import androidx.compose.animation.core.EaseOutCubic
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.tooling.preview.Preview
import dev.orbit.dock.ui.theme.DockPalette
import dev.orbit.dock.ui.theme.NodeDockTheme
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** Face redraw cadence (~30 fps). The face's continuous breathing/drift doesn't
 *  need 60 fps; capping it halves the frames pushed, easing GPU + compositor
 *  load on weak devices (Snapdragon 636) where 60 fps full-screen redraw +
 *  camera SurfaceView overruns the frame budget. */
private const val FACE_ANIM_FRAME_MS = 33L

/**
 * The dock's face.
 *
 * Expressions now drive visible visual deltas via [ExpressionShape] — see
 * [shapeFor]. Each numeric field is tweened with [animateFloatAsState] keyed
 * on the expression so transitions are smooth, never snap.
 */
@Composable
fun FaceRenderer(
    modifier: Modifier = Modifier,
    state: FaceState,
    gaze: GazeOffset,
    expression: FaceExpression,
    privacy: Boolean,
    /**
     * When true, the eyes close (independent of full privacy mode).
     * Used to signal "I can't see you" when the camera is muted —
     * the dock has gone blind even if it's still listening.
     */
    eyesClosed: Boolean = false,
    compactFraction: Float = 1f,
    /**
     * When true, all animations (breath, drift, blink, micro-saccades)
     * are pinned to neutral values. Used by the face gallery so each
     * screenshot is deterministic and you can compare expressions
     * apples-to-apples across renderer versions.
     */
    staticForScreenshot: Boolean = false,
) {
    // Treat explicit "eyes closed" as a soft form of privacy for the
    // lid-animation + halo logic — keeps the mouth/brows/etc. alive
    // (we're listening) but pulls the lids shut (we're not watching).
    val lidsClosed = privacy || eyesClosed
    val baseColor by animateColorAsState(
        targetValue = currentEyeColor(state, expression, privacy),
        animationSpec = tween(durationMillis = 600, easing = EaseInOutCubic),
        label = "eye-color",
    )

    val breathPeriod = when (expression) {
        FaceExpression.Excited -> 2200
        FaceExpression.Sleepy -> 6500
        else -> 4200
    }

    // Throttled animation clock. An infiniteTransition redraws the full-screen
    // face every display vsync (60 Hz); on weak GPUs that, combined with the
    // camera SurfaceView's compositor load, blows the frame budget ~40% of the
    // time (measured via gfxinfo + atrace dequeueBuffer stalls). Advancing a
    // wall-clock-derived time only every FACE_ANIM_FRAME_MS caps the face redraw
    // to ~30 fps — breathing/drift still look smooth, ~half the frames pushed.
    val animClockMs = remember { mutableStateOf(0L) }
    LaunchedEffect(staticForScreenshot) {
        if (staticForScreenshot) { animClockMs.value = breathPeriod / 2L; return@LaunchedEffect }
        val startNanos = withFrameNanos { nanos -> nanos }
        var lastEmit = -FACE_ANIM_FRAME_MS
        while (true) {
            val elapsedMs = (withFrameNanos { nanos -> nanos } - startNanos) / 1_000_000L
            if (elapsedMs - lastEmit >= FACE_ANIM_FRAME_MS) {
                lastEmit = elapsedMs
                animClockMs.value = elapsedMs
            }
        }
    }
    val tMs = animClockMs.value
    // breath: 0..1..0 triangle over breathPeriod, smoothstepped (EaseInOut feel).
    val breath = run {
        val phase = (tMs % breathPeriod).toFloat() / breathPeriod
        val tri = if (phase < 0.5f) phase * 2f else (1f - phase) * 2f
        tri * tri * (3f - 2f * tri)
    }
    val driftPhase = ((tMs % 9000L).toFloat() / 9000f) * (Math.PI * 2).toFloat()

    val lid = remember { Animatable(1f) }
    LaunchedEffect(lidsClosed, expression, staticForScreenshot) {
        if (staticForScreenshot) {
            if (lidsClosed) lid.snapTo(0.18f) else lid.snapTo(1f)
            return@LaunchedEffect
        }
        if (lidsClosed) {
            lid.animateTo(0.05f, animationSpec = tween(durationMillis = 280, easing = EaseInOutCubic))
        } else {
            // Eyes were closed (cam mute / privacy) — make sure we
            // explicitly re-open before entering the blink loop, otherwise
            // the lid stays at 0.05 until the first random blink fires.
            if (lid.value < 0.95f) {
                lid.animateTo(1f, animationSpec = tween(durationMillis = 280, easing = EaseOutCubic))
            }
            while (true) {
                val baseWait = (2200..6500).random()
                val scale = if (expression == FaceExpression.Sleepy) 0.6f else 1f
                val wait = (baseWait * scale).toLong()
                delay(wait)
                if (lidsClosed) break
                lid.animateTo(0f, animationSpec = tween(durationMillis = 130, easing = EaseInOutCubic))
                lid.animateTo(1f, animationSpec = tween(durationMillis = 180, easing = EaseOutCubic))
                if (Random.nextFloat() < 0.18f) {
                    delay(110)
                    lid.animateTo(0f, animationSpec = tween(durationMillis = 110, easing = EaseInOutCubic))
                    lid.animateTo(1f, animationSpec = tween(durationMillis = 160, easing = EaseOutCubic))
                }
            }
        }
    }

    var microX by remember { mutableFloatStateOf(0f) }
    var microY by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(state) {
        if (state == FaceState.Idle || state == FaceState.Listening) {
            while (true) {
                delay((900..2400).random().toLong())
                microX = Random.nextFloat() * 2f - 1f
                microY = Random.nextFloat() * 1.4f - 0.7f
                delay((180..420).random().toLong())
                microX = 0f
                microY = 0f
            }
        } else {
            microX = 0f
            microY = 0f
        }
    }
    val microXAnim by animateFloatAsState(
        targetValue = microX,
        animationSpec = tween(durationMillis = 90, easing = EaseOutCubic),
        label = "microX",
    )
    val microYAnim by animateFloatAsState(
        targetValue = microY,
        animationSpec = tween(durationMillis = 90, easing = EaseOutCubic),
        label = "microY",
    )

    val thinkingActive = state == FaceState.Engaged
    val thinkingPull by animateFloatAsState(
        targetValue = if (thinkingActive) 1f else 0f,
        animationSpec = tween(durationMillis = 260, easing = EaseOutCubic),
        label = "thinking",
    )

    val pupilTarget = when (state) {
        FaceState.Engaged -> 1.45f
        FaceState.Listening -> 1.28f
        FaceState.Speaking -> 1.12f
        FaceState.Illustrating -> 0.95f
        FaceState.Idle -> 1.0f
    }
    val pupilDilate by animateFloatAsState(
        targetValue = pupilTarget,
        animationSpec = tween(durationMillis = 240, easing = EaseOutCubic),
        label = "pupil",
    )

    val haloStateTarget = when (state) {
        FaceState.Engaged -> 1f
        FaceState.Listening -> 0.85f
        FaceState.Speaking -> 0.7f
        FaceState.Illustrating, FaceState.Idle -> 0.4f
    }
    val targetShape = shapeFor(expression)
    val haloTarget = (haloStateTarget * targetShape.haloMul).coerceIn(0f, 1.4f)
    val halo by animateFloatAsState(
        targetValue = if (privacy) 0f else haloTarget,
        animationSpec = tween(durationMillis = 360, easing = EaseInOutCubic),
        label = "halo",
    )

    val cheekTarget = when {
        state == FaceState.Speaking -> 1f
        targetShape.cheekAlwaysOn -> 0.85f
        else -> 0f
    }
    val cheek by animateFloatAsState(
        targetValue = cheekTarget,
        animationSpec = tween(durationMillis = 420, easing = EaseOutCubic),
        label = "cheek",
    )

    // Single coordinated transition between expressions: lerp every shape
    // field from the previous snapshot to the new one on a single timeline.
    // Replaces ~15 independent animateFloatAsState calls that each tweened
    // on their own clock and produced "fifteen things moving independently".
    //
    // Subtle: we keep `fromShape` + `toShape` as our own state (not just
    // derived from `expression`) and only update them inside the
    // LaunchedEffect that drives `progress`. This avoids the first-frame
    // glitch where progress was still 1 from the previous animation and
    // lerp(prev, NEW_target, 1) would snap to the new target before the
    // animation could start.
    val fromShape = remember { mutableStateOf(targetShape) }
    val toShape = remember { mutableStateOf(targetShape) }
    val progress = remember { Animatable(0f) }
    LaunchedEffect(targetShape) {
        // Snapshot current rendered shape as the new "from"
        fromShape.value = lerpExpressionShape(fromShape.value, toShape.value, progress.value)
        toShape.value = targetShape
        progress.snapTo(0f)
        progress.animateTo(1f, tween(280, easing = EaseInOutCubic))
    }
    val shape = lerpExpressionShape(fromShape.value, toShape.value, progress.value)

    val lidBottomCurve = shape.lidBottomCurve
    val lidTopCurveInner = shape.lidTopCurveInner
    val eyeScaleX = shape.eyeScaleX
    val eyeScaleY = shape.eyeScaleY
    val lidClamp = shape.lidClamp
    val pupilScale = shape.pupilScale
    val tiltDeg = shape.tiltDeg
    val asymmetry = shape.asymmetry
    val gazeYBias = shape.gazeYBias
    val browShow = shape.browShow
    val browInnerY = shape.browInnerY
    val browOuterY = shape.browOuterY
    val browTilt = shape.browTilt
    val browThick = shape.browThick
    val browArch = shape.browArch
    val mouthOpenAnim = shape.mouthOpen

    Box(modifier = modifier.fillMaxSize()) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val centerY = h * 0.5f

            val baseEyeRadius = (minOf(w, h) * 0.18f) * compactFraction
            val effBreath = if (staticForScreenshot) 0.5f else breath
            val breathScale = 0.965f + effBreath * 0.07f
            val r = baseEyeRadius * breathScale

            val driftX = if (state == FaceState.Idle && !staticForScreenshot) cos(driftPhase) * 6f else 0f
            val driftY = if (state == FaceState.Idle && !staticForScreenshot) sin(driftPhase * 1.27f) * 4f else 0f

            val thinkX = -thinkingPull * r * 0.18f
            val thinkY = -thinkingPull * r * 0.14f

            val microXEff = if (staticForScreenshot) 0f else microXAnim
            val microYEff = if (staticForScreenshot) 0f else microYAnim
            val gazeX = gaze.x * r * 0.34f + driftX + microXEff * r * 0.06f + thinkX
            val gazeY = gaze.y * r * 0.34f + driftY + microYEff * r * 0.05f + thinkY + gazeYBias * r

            val eyeGap = baseEyeRadius * 1.7f
            val leftCenter = Offset(w * 0.5f - eyeGap, centerY)
            val rightCenter = Offset(w * 0.5f + eyeGap, centerY)

            rotate(degrees = tiltDeg, pivot = Offset(w * 0.5f, centerY)) {
                if (halo > 0.01f) {
                    drawHalo(leftCenter, baseEyeRadius * 2.3f, halo)
                    drawHalo(rightCenter, baseEyeRadius * 2.3f, halo)
                }

                if (cheek > 0.01f) {
                    val cheekY = centerY + r * 1.9f
                    drawCheek(Offset(leftCenter.x, cheekY), r * 0.65f, cheek)
                    drawCheek(Offset(rightCenter.x, cheekY), r * 0.65f, cheek)
                }

                val isWink = expression == FaceExpression.Wink
                val leftLid = lid.value.coerceAtMost(lidClamp)
                val rightLid = lid.value.coerceAtMost(lidClamp)

                val leftR = r * (1f - asymmetry * 0.5f)
                val rightR = r * (1f + asymmetry * 0.5f)

                // In wink, the open eye exaggerates (wider + slight pupil
                // dilation) so the two-eye contrast reads strongly as a wink
                // rather than just "one eye closed".
                val winkBoostX = if (isWink) 1.15f else 1f
                val winkBoostY = if (isWink) 1.15f else 1f
                val winkPupil = if (isWink) 1.2f else 1f

                if (isWink) {
                    // Left eye is winked: draw a closed-eye arc smile.
                    drawWinkedEye(leftCenter, leftR * eyeScaleX, leftR * 0.5f, baseColor)
                } else {
                    drawEye(
                        center = leftCenter,
                        radius = leftR,
                        lidOpen = leftLid,
                        gazeX = gazeX,
                        gazeY = gazeY,
                        pupilDilate = pupilDilate * pupilScale,
                        color = baseColor,
                        eyeScaleX = eyeScaleX,
                        eyeScaleY = eyeScaleY,
                        lidBottomCurve = lidBottomCurve,
                        lidTopCurveInner = lidTopCurveInner,
                        isLeft = true,
                        expression = expression,
                    )
                }
                drawEye(
                    center = rightCenter,
                    radius = rightR,
                    lidOpen = rightLid,
                    gazeX = gazeX,
                    gazeY = gazeY,
                    pupilDilate = pupilDilate * pupilScale * winkPupil,
                    color = baseColor,
                    eyeScaleX = eyeScaleX * winkBoostX,
                    eyeScaleY = eyeScaleY * winkBoostY,
                    lidBottomCurve = lidBottomCurve,
                    lidTopCurveInner = lidTopCurveInner,
                    isLeft = false,
                    expression = expression,
                )

                // Mouth — below the eyes
                if (targetShape.mouthKind != MOUTH_NONE && !privacy && mouthOpenAnim > 0.02f) {
                    val mouthCenter = Offset(w * 0.5f, centerY + r * 2.1f)
                    drawMouth(
                        center = mouthCenter,
                        size = r * 0.85f * mouthOpenAnim,
                        kind = targetShape.mouthKind,
                        color = DockPalette.OnBackground.copy(alpha = 0.92f),
                    )
                }

                if (targetShape.accent != ACCENT_NONE && !privacy) {
                    drawAccent(
                        kind = targetShape.accent,
                        leftEye = leftCenter,
                        rightEye = rightCenter,
                        eyeR = r,
                    )
                }

                if (browShow > 0.01f && !privacy) {
                    val browColor = DockPalette.OnBackground.copy(alpha = 0.95f * browShow)
                    drawBrow(
                        eyeCenter = leftCenter,
                        eyeRx = r * eyeScaleX * (1f - asymmetry * 0.5f),
                        eyeRy = r * eyeScaleY,
                        innerY = browInnerY,
                        outerY = browOuterY,
                        tilt = browTilt,
                        thick = browThick * r * 0.10f,
                        arch = browArch,
                        isLeft = true,
                        color = browColor,
                    )
                    drawBrow(
                        eyeCenter = rightCenter,
                        eyeRx = r * eyeScaleX * (1f + asymmetry * 0.5f),
                        eyeRy = r * eyeScaleY,
                        innerY = browInnerY,
                        outerY = browOuterY,
                        tilt = -browTilt,  // mirror
                        thick = browThick * r * 0.10f,
                        arch = browArch,
                        isLeft = false,
                        color = browColor,
                    )
                }
            }
        }
    }
}

private fun DrawScope.drawAccent(
    kind: Int,
    leftEye: Offset,
    rightEye: Offset,
    eyeR: Float,
) {
    when (kind) {
        ACCENT_TEAR -> {
            // Single tear under the right eye
            val c = Offset(rightEye.x + eyeR * 0.4f, rightEye.y + eyeR * 1.3f)
            drawTear(c, eyeR * 0.35f, DockPalette.EyeBright.copy(alpha = 0.85f))
        }
        ACCENT_SPARKLE -> {
            // 4-pointed stars positioned safely inside the cell bounds
            val positions = listOf(
                Offset(leftEye.x - eyeR * 1.2f, leftEye.y - eyeR * 0.7f) to eyeR * 0.38f,
                Offset(rightEye.x + eyeR * 1.2f, rightEye.y - eyeR * 0.4f) to eyeR * 0.28f,
                Offset(leftEye.x - eyeR * 1.5f, leftEye.y + eyeR * 0.9f) to eyeR * 0.22f,
                Offset(rightEye.x + eyeR * 0.8f, rightEye.y + eyeR * 1.4f) to eyeR * 0.25f,
            )
            for ((p, s) in positions) {
                drawSparkle(p, s, Color(0xFFFFE9A6))
            }
        }
        ACCENT_HEART -> {
            // Hearts floating to the sides of the face (not above — gallery
            // cell tops clip them). Big + small for variety.
            drawPath(
                heartPath(Offset(leftEye.x - eyeR * 1.7f, leftEye.y - eyeR * 0.4f), eyeR * 0.55f),
                color = DockPalette.Cheek,
            )
            drawPath(
                heartPath(Offset(rightEye.x + eyeR * 1.5f, rightEye.y + eyeR * 0.6f), eyeR * 0.35f),
                color = DockPalette.Cheek.copy(alpha = 0.85f),
            )
        }
        ACCENT_ANGER -> {
            // # symbol beside upper-left of head, pulled in red
            val c = Offset(leftEye.x - eyeR * 1.6f, leftEye.y - eyeR * 1.5f)
            drawAngerMark(c, eyeR * 0.45f, DockPalette.Bad)
        }
        ACCENT_ZZZ -> {
            val color = DockPalette.OnBackground.copy(alpha = 0.85f)
            drawZ(Offset(rightEye.x + eyeR * 1.1f, rightEye.y - eyeR * 1.6f), eyeR * 0.35f, color)
            drawZ(Offset(rightEye.x + eyeR * 1.6f, rightEye.y - eyeR * 2.4f), eyeR * 0.45f, color)
            drawZ(Offset(rightEye.x + eyeR * 2.2f, rightEye.y - eyeR * 3.2f), eyeR * 0.55f, color)
        }
        ACCENT_SWEAT -> {
            // Single sweat drop beside head, tilted
            val c = Offset(rightEye.x + eyeR * 1.5f, rightEye.y - eyeR * 0.4f)
            drawTear(c, eyeR * 0.4f, DockPalette.EyeBright.copy(alpha = 0.9f))
        }
        ACCENT_QUESTION -> {
            // ? mark beside upper-right of head
            val c = Offset(rightEye.x + eyeR * 1.6f, rightEye.y - eyeR * 1.5f)
            drawQuestion(c, eyeR * 0.7f, DockPalette.Accent)
        }
    }
}

private fun DrawScope.drawTear(center: Offset, size: Float, color: Color) {
    // Teardrop = circle with pointed top
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
    // Catchlight on tear
    drawCircle(
        Color.White.copy(alpha = 0.5f),
        radius = size * 0.18f,
        center = Offset(center.x - size * 0.25f, center.y + size * 0.1f),
    )
}

private fun DrawScope.drawSparkle(center: Offset, size: Float, color: Color) {
    val path = Path().apply {
        moveTo(center.x, center.y - size)
        cubicTo(
            center.x + size * 0.3f, center.y - size * 0.3f,
            center.x + size * 0.3f, center.y - size * 0.3f,
            center.x + size, center.y,
        )
        cubicTo(
            center.x + size * 0.3f, center.y + size * 0.3f,
            center.x + size * 0.3f, center.y + size * 0.3f,
            center.x, center.y + size,
        )
        cubicTo(
            center.x - size * 0.3f, center.y + size * 0.3f,
            center.x - size * 0.3f, center.y + size * 0.3f,
            center.x - size, center.y,
        )
        cubicTo(
            center.x - size * 0.3f, center.y - size * 0.3f,
            center.x - size * 0.3f, center.y - size * 0.3f,
            center.x, center.y - size,
        )
        close()
    }
    drawPath(path, color)
}

private fun DrawScope.drawAngerMark(center: Offset, size: Float, color: Color) {
    // Stylised # / starburst manga anger mark — 3 short radial strokes
    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(
        width = size * 0.18f,
        cap = androidx.compose.ui.graphics.StrokeCap.Round,
    )
    val angles = listOf(-90f, -30f, 30f, 90f, 150f, 210f)
    for (a in angles) {
        val rad = Math.toRadians(a.toDouble())
        val sx = center.x + (kotlin.math.cos(rad) * size * 0.35f).toFloat()
        val sy = center.y + (kotlin.math.sin(rad) * size * 0.35f).toFloat()
        val ex = center.x + (kotlin.math.cos(rad) * size).toFloat()
        val ey = center.y + (kotlin.math.sin(rad) * size).toFloat()
        drawLine(color, Offset(sx, sy), Offset(ex, ey), strokeWidth = stroke.width, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

private fun DrawScope.drawZ(center: Offset, size: Float, color: Color) {
    val w = size
    val h = size
    val path = Path().apply {
        moveTo(center.x - w / 2, center.y - h / 2)
        lineTo(center.x + w / 2, center.y - h / 2)
        lineTo(center.x - w / 2, center.y + h / 2)
        lineTo(center.x + w / 2, center.y + h / 2)
    }
    drawPath(
        path, color,
        style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = size * 0.18f,
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
            join = androidx.compose.ui.graphics.StrokeJoin.Round,
        ),
    )
}

private fun DrawScope.drawQuestion(center: Offset, size: Float, color: Color) {
    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(
        width = size * 0.22f,
        cap = androidx.compose.ui.graphics.StrokeCap.Round,
        join = androidx.compose.ui.graphics.StrokeJoin.Round,
    )
    // Top loop of ?
    val r = size * 0.35f
    val loopCenter = Offset(center.x, center.y - size * 0.25f)
    val path = Path().apply {
        moveTo(loopCenter.x - r, loopCenter.y - r * 0.2f)
        cubicTo(
            loopCenter.x - r, loopCenter.y - r * 1.5f,
            loopCenter.x + r, loopCenter.y - r * 1.5f,
            loopCenter.x + r, loopCenter.y - r * 0.2f,
        )
        cubicTo(
            loopCenter.x + r, loopCenter.y + r * 0.7f,
            loopCenter.x, loopCenter.y + r * 0.8f,
            loopCenter.x, loopCenter.y + r * 1.2f,
        )
    }
    drawPath(path, color, style = stroke)
    // Dot
    drawCircle(
        color, radius = size * 0.12f,
        center = Offset(center.x, center.y + size * 0.55f),
    )
}

private fun DrawScope.drawWinkedEye(
    center: Offset,
    rx: Float,
    ry: Float,
    color: Color,
) {
    // Closed-eye smile: a wide upturned arc, like ^
    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(
        width = (ry * 0.45f).coerceAtLeast(4f),
        cap = androidx.compose.ui.graphics.StrokeCap.Round,
        join = androidx.compose.ui.graphics.StrokeJoin.Round,
    )
    val path = Path().apply {
        moveTo(center.x - rx, center.y + ry * 0.3f)
        quadraticTo(center.x, center.y - ry * 1.1f, center.x + rx, center.y + ry * 0.3f)
    }
    drawPath(path, color, style = stroke)
}

private fun DrawScope.drawMouth(
    center: Offset,
    size: Float,
    kind: Int,
    color: Color,
) {
    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(
        width = (size * 0.18f).coerceAtLeast(3f),
        cap = androidx.compose.ui.graphics.StrokeCap.Round,
        join = androidx.compose.ui.graphics.StrokeJoin.Round,
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
            drawCircle(
                color = color,
                radius = h * 0.55f,
                center = center,
                style = stroke,
            )
        }
        MOUTH_BIG_SMILE -> {
            // Open D-shape grin: flat top, arched bottom (like an open laugh).
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
            // Pink tongue accent — clipped lower portion shows
            val tonguePath = Path().apply {
                addOval(
                    androidx.compose.ui.geometry.Rect(
                        offset = Offset(center.x - w * 0.32f, center.y + h * 0.45f),
                        size = androidx.compose.ui.geometry.Size(w * 0.64f, h * 0.85f),
                    ),
                )
            }
            drawPath(tonguePath, DockPalette.Cheek)
        }
        MOUTH_FLAT -> {
            drawLine(
                color = color,
                start = Offset(center.x - w / 2, center.y),
                end = Offset(center.x + w / 2, center.y),
                strokeWidth = stroke.width,
                cap = androidx.compose.ui.graphics.StrokeCap.Round,
            )
        }
        MOUTH_GRIN_TEETH -> {
            // Bared-teeth grin: trapezoid mouth outline + zigzag teeth inside.
            val mouthH = h * 0.7f
            val outline = Path().apply {
                moveTo(center.x - w / 2, center.y - mouthH * 0.2f)
                lineTo(center.x + w / 2, center.y - mouthH * 0.2f)
                lineTo(center.x + w / 2 * 0.85f, center.y + mouthH * 0.55f)
                lineTo(center.x - w / 2 * 0.85f, center.y + mouthH * 0.55f)
                close()
            }
            drawPath(outline, color)
            // Zigzag teeth in white-ish
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
private fun DrawScope.drawBrow(
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
    // Brow sits above the eye. Gap scales with eye height.
    val gap = eyeRy * 0.55f
    val baselineY = eyeCenter.y - eyeRy - gap
    val halfLen = eyeRx * 0.9f
    val tiltOff = (halfLen * kotlin.math.tan(Math.toRadians(tilt.toDouble())).toFloat())

    // Inner / outer ends
    val innerX = if (isLeft) eyeCenter.x + halfLen else eyeCenter.x - halfLen
    val outerX = if (isLeft) eyeCenter.x - halfLen else eyeCenter.x + halfLen

    // innerY/outerY are in units of (eye height); positive moves DOWN.
    val innerEndY = baselineY + innerY * eyeRy + (if (isLeft) tiltOff else -tiltOff)
    val outerEndY = baselineY + outerY * eyeRy - (if (isLeft) tiltOff else -tiltOff)

    // Arch: midpoint Y offset (negative = curves UP / over the eye)
    val midX = (innerX + outerX) / 2f
    val midY = (innerEndY + outerEndY) / 2f - arch * eyeRy * 0.45f

    val path = Path().apply {
        moveTo(outerX, outerEndY)
        quadraticTo(midX, midY, innerX, innerEndY)
    }
    drawPath(
        path = path,
        color = color,
        style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = thick.coerceAtLeast(2f),
            cap = androidx.compose.ui.graphics.StrokeCap.Round,
            join = androidx.compose.ui.graphics.StrokeJoin.Round,
        ),
    )
}

/**
 * Numeric deltas an expression applies on top of base eye drawing.
 * Tweened by [animateFloatAsState] so transitions are smooth.
 */
private data class ExpressionShape(
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
    // Brows. innerY < 0 = inner end goes UP (sad/surprised), > 0 = DOWN (angry/concerned).
    // outerY analogous. tilt rotates the whole brow stroke. show=0 hides brows.
    val browShow: Float = 0f,
    val browInnerY: Float = 0f,    // -1..+1 (× brow gap)
    val browOuterY: Float = 0f,
    val browTilt: Float = 0f,      // degrees
    val browThick: Float = 1f,     // scale
    val browArch: Float = 0f,      // -1 flat, 0 slight arch, +1 high arch
    // Mouth. shape: 0=hide; 1=smile; -1=frown; 0.5=small smile; 2=O (surprise);
    //               3=open-mouth excited; 4=flat line; 5=zigzag (angry)
    val mouthKind: Int = MOUTH_NONE,
    val mouthOpen: Float = 0f,     // 0..1 size scale
    val accent: Int = ACCENT_NONE,
)

private const val MOUTH_NONE = 0
private const val MOUTH_SMILE = 1
private const val MOUTH_FROWN = 2
private const val MOUTH_O = 3
private const val MOUTH_BIG_SMILE = 4
private const val MOUTH_FLAT = 5
private const val MOUTH_GRIN_TEETH = 6

// Decorative accent overlays — sparkles, tear, hearts, etc. Drawn after
// the rest of the face. Each is positioned by drawAccent.
private const val ACCENT_NONE = 0
private const val ACCENT_TEAR = 1        // single drop on cheek (sad)
private const val ACCENT_SPARKLE = 2     // 3 stars around face (excited)
private const val ACCENT_HEART = 3       // pair of hearts above (love)
private const val ACCENT_ANGER = 4       // # mark beside head (angry)
private const val ACCENT_ZZZ = 5         // sleepy z's
private const val ACCENT_SWEAT = 6       // single sweat drop (concerned)
private const val ACCENT_QUESTION = 7    // ? mark beside head (curious)
private const val ACCENT_BLUSH_EXTRA = 8 // strong cheek blush (used as combo)

/**
 * Linearly interpolate every numeric field of [ExpressionShape]. Discrete
 * fields (mouthKind, accent, cheekAlwaysOn) snap to the target's value at
 * t=0.5 — these are categorical, not blendable, but the visual flip
 * mid-tween hides under the eye/brow motion.
 */
private fun lerpExpressionShape(a: ExpressionShape, b: ExpressionShape, t: Float): ExpressionShape {
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

private fun shapeFor(e: FaceExpression): ExpressionShape = when (e) {
    FaceExpression.Neutral -> ExpressionShape(
        browShow = 0.6f, browArch = 0.2f,
    )
    FaceExpression.Happy -> ExpressionShape(
        // Strong kawaii smile-eyes (^^), big cheeks, big halo.
        lidBottomCurve = 1.6f, lidClamp = 0.55f,
        cheekAlwaysOn = true, haloMul = 1.35f,
        browShow = 0.9f, browArch = 1f, browOuterY = -0.25f, browInnerY = -0.1f,
        mouthKind = MOUTH_SMILE, mouthOpen = 1f,
    )
    FaceExpression.Curious -> ExpressionShape(
        // Big head tilt, one brow up (browTilt asymmetry), one eye bigger
        // pupil than the other. Reads as "huh, tell me more".
        tiltDeg = 16f, asymmetry = 0.4f, pupilScale = 1.4f, eyeScaleY = 1.15f,
        browShow = 1f, browInnerY = -0.5f, browArch = 0.6f, browTilt = 8f,
        mouthKind = MOUTH_FLAT, mouthOpen = 0.4f,
        accent = ACCENT_QUESTION,
    )
    FaceExpression.Concerned -> ExpressionShape(
        // OPEN worried eyes (not narrow like sad). Pupils dilated, halo
        // dimmer but eyes large enough to scan + show vulnerability.
        eyeScaleX = 1.1f, eyeScaleY = 1.1f, pupilScale = 1.25f, haloMul = 0.6f,
        gazeYBias = 0.05f,
        browShow = 1f, browInnerY = 0.55f, browTilt = 12f, browThick = 1.15f,
        mouthKind = MOUTH_FROWN, mouthOpen = 0.85f,
        accent = ACCENT_SWEAT,
    )
    FaceExpression.Surprised -> ExpressionShape(
        // Wide-open eyes with TINY pupils — classic deer-in-headlights.
        eyeScaleX = 1.55f, eyeScaleY = 1.55f, pupilScale = 0.65f, haloMul = 1.45f,
        browShow = 1f, browInnerY = -0.85f, browOuterY = -0.85f, browArch = 1.2f, browThick = 1.1f,
        mouthKind = MOUTH_O, mouthOpen = 1.1f,
    )
    FaceExpression.Sleepy -> ExpressionShape(
        // Heavy lid clamp + low gaze + dim halo.
        lidClamp = 0.18f, haloMul = 0.4f, pupilScale = 0.8f, gazeYBias = 0.15f,
        browShow = 0.45f, browArch = -0.5f, browOuterY = 0.25f,
        mouthKind = MOUTH_FLAT, mouthOpen = 0.35f,
        accent = ACCENT_ZZZ,
    )
    FaceExpression.Wink -> ExpressionShape(
        // The left-eye-only smile-arc is handled in renderer; keep cheeks + grin.
        lidBottomCurve = 1.2f, cheekAlwaysOn = true, haloMul = 1.15f,
        browShow = 0.85f, browArch = 0.6f, browOuterY = -0.2f,
        mouthKind = MOUTH_SMILE, mouthOpen = 0.95f,
    )
    FaceExpression.Sad -> ExpressionShape(
        // Droopy: inner-top lifts (puppy eyes), gaze WAY down, lid clamp narrows.
        lidTopCurveInner = -0.9f, haloMul = 0.4f, gazeYBias = 0.42f,
        pupilScale = 1.05f, eyeScaleY = 0.85f, lidClamp = 0.78f,
        browShow = 1f, browInnerY = -0.7f, browTilt = -10f, browArch = -0.2f,
        mouthKind = MOUTH_FROWN, mouthOpen = 0.9f,
        accent = ACCENT_TEAR,
    )
    FaceExpression.Excited -> ExpressionShape(
        // Buzzy: huge eyes, dilated pupils, brightest halo, big open mouth.
        eyeScaleX = 1.3f, eyeScaleY = 1.4f, haloMul = 1.55f, pupilScale = 1.6f,
        cheekAlwaysOn = true,
        browShow = 1f, browInnerY = -0.45f, browArch = 1.1f, browOuterY = -0.4f, browThick = 1.05f,
        mouthKind = MOUTH_BIG_SMILE, mouthOpen = 1.1f,
        accent = ACCENT_SPARKLE,
    )
    FaceExpression.Angry -> ExpressionShape(
        // Narrow, pinprick pupils, sharp lid, dim halo (intense).
        lidTopCurveInner = 1.3f, lidClamp = 0.42f, haloMul = 0.45f,
        pupilScale = 0.55f, eyeScaleY = 0.72f, eyeScaleX = 1.05f,
        browShow = 1f, browInnerY = 0.7f, browTilt = -18f, browThick = 1.4f, browArch = -0.3f,
        mouthKind = MOUTH_GRIN_TEETH, mouthOpen = 0.95f,
        accent = ACCENT_ANGER,
    )
    FaceExpression.Love -> ExpressionShape(
        // Heart-pupils handled in pupil drawer when expression==Love.
        // Smile arc + strong cheeks + soft mouth.
        lidBottomCurve = 0.85f, cheekAlwaysOn = true, haloMul = 1.35f, pupilScale = 1.45f,
        browShow = 0.85f, browArch = 0.85f, browOuterY = -0.2f,
        mouthKind = MOUTH_SMILE, mouthOpen = 0.8f,
        accent = ACCENT_HEART,
    )
}

private fun DrawScope.drawHalo(center: Offset, radius: Float, intensity: Float) {
    val brush = Brush.radialGradient(
        colors = listOf(
            DockPalette.EyeGlow.copy(alpha = (0.30f * intensity).coerceIn(0f, 1f)),
            DockPalette.EyeGlow.copy(alpha = (0.10f * intensity).coerceIn(0f, 1f)),
            Color.Transparent,
        ),
        center = center,
        radius = radius,
    )
    drawCircle(brush = brush, radius = radius, center = center)
}

private fun DrawScope.drawCheek(center: Offset, radius: Float, intensity: Float) {
    val brush = Brush.radialGradient(
        colors = listOf(
            DockPalette.Cheek.copy(alpha = 0.35f * intensity),
            DockPalette.Cheek.copy(alpha = 0.12f * intensity),
            Color.Transparent,
        ),
        center = center,
        radius = radius,
    )
    drawCircle(brush = brush, radius = radius, center = center)
}

@Suppress("LongParameterList")
private fun DrawScope.drawEye(
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
                color = DockPalette.Cheek,
            )
        } else {
            // Angry pupils are pinprick + crimson-tinged for the "intense
            // stare" read. Everyone else uses the standard ink-dot.
            val pupilColor = if (expression == FaceExpression.Angry) {
                DockPalette.Bad.copy(red = 0.4f, alpha = 1f).let {
                    Color(red = 0.35f, green = 0f, blue = 0f, alpha = 1f)
                }
            } else {
                DockPalette.Pupil
            }
            drawCircle(
                color = pupilColor,
                radius = pupilR,
                center = pupilCenter,
            )
            // Excited gets a 4-point sparkle overlaid on the pupil — bigger
            // visual cue than just "dilated round dot".
            if (expression == FaceExpression.Excited) {
                drawSparkle(pupilCenter, pupilR * 1.4f, DockPalette.Accent.copy(alpha = 0.9f))
            }
        }
        val catchScale = (lidOpen - 0.22f) / 0.78f
        // Big upper catchlight — makes the eye feel alive + 3D
        drawCircle(
            color = DockPalette.Catchlight.copy(alpha = 0.98f * catchScale),
            radius = radius * 0.13f,
            center = Offset(
                pupilCenter.x - radius * 0.13f,
                pupilCenter.y - radius * 0.16f,
            ),
        )
        // Small lower-right secondary highlight
        drawCircle(
            color = DockPalette.Catchlight.copy(alpha = 0.55f * catchScale),
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
private fun buildEyePath(
    center: Offset,
    rx: Float,
    halfH: Float,
    lidBottomCurve: Float,
    lidTopCurveInner: Float,
    isLeft: Boolean,
): Path {
    // Build the eye as a proper ellipse (4 cubic quadrants with the
    // bezier-circle constant K=0.5523), then displace specific anchor
    // points to express smile/sad/etc.
    val k = 0.5523f
    val cx = center.x
    val cy = center.y
    val top = cy - halfH
    val bot = cy + halfH
    val left = cx - rx
    val right = cx + rx

    // Smile lift (positive) pulls the bottom UP and rounds it more.
    // Cap at 1.8 (was 1.2) so we can push happy all the way to crescent ^^.
    val lift = halfH * 0.85f * lidBottomCurve.coerceIn(0f, 1.8f)
    val effBot = bot - lift

    // Inner-top displacement: +ve pulls inner corner down (angry), -ve up (sad).
    val innerDelta = halfH * 0.9f * lidTopCurveInner
    val (topLeftY, topRightY) = if (isLeft) {
        top to (top + innerDelta)
    } else {
        (top + innerDelta) to top
    }

    val path = Path()
    // Top-right quadrant (start at top center, sweep right)
    val topMidY = (topLeftY + topRightY) / 2f
    path.moveTo(cx, topMidY)
    path.cubicTo(
        cx + rx * k, topMidY,
        right, topRightY + halfH * (1f - k),
        right, cy,
    )
    // Right-bottom quadrant
    path.cubicTo(
        right, cy + (effBot - cy) * k,
        cx + rx * k, effBot,
        cx, effBot,
    )
    // Bottom-left quadrant
    path.cubicTo(
        cx - rx * k, effBot,
        left, cy + (effBot - cy) * k,
        left, cy,
    )
    // Left-top quadrant
    path.cubicTo(
        left, topLeftY + halfH * (1f - k),
        cx - rx * k, topMidY,
        cx, topMidY,
    )
    path.close()
    return path
}

private fun heartPath(center: Offset, size: Float): Path {
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

private fun currentEyeColor(
    state: FaceState,
    expression: FaceExpression,
    privacy: Boolean,
): Color = when {
    privacy -> DockPalette.EyeDim
    expression == FaceExpression.Sleepy -> DockPalette.EyeDim
    expression == FaceExpression.Sad -> DockPalette.EyeDim
    expression == FaceExpression.Angry -> DockPalette.Bad
    expression == FaceExpression.Excited -> DockPalette.EyeBright
    expression == FaceExpression.Happy -> DockPalette.EyeBright
    state == FaceState.Speaking -> DockPalette.EyeBright
    state == FaceState.Engaged -> DockPalette.EyeBright
    else -> DockPalette.EyeBase
}

@Preview(widthDp = 720, heightDp = 360, backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewIdle() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Idle,
            gaze = GazeOffset(),
            expression = FaceExpression.Neutral,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Happy",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewHappy() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Speaking,
            gaze = GazeOffset(),
            expression = FaceExpression.Happy,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Curious",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewCurious() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Engaged,
            gaze = GazeOffset(0.4f, -0.2f),
            expression = FaceExpression.Curious,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Concerned",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewConcerned() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Listening,
            gaze = GazeOffset(),
            expression = FaceExpression.Concerned,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Surprised",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewSurprised() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Engaged,
            gaze = GazeOffset(),
            expression = FaceExpression.Surprised,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Sleepy",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewSleepy() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Idle,
            gaze = GazeOffset(),
            expression = FaceExpression.Sleepy,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Wink",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewWink() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Speaking,
            gaze = GazeOffset(),
            expression = FaceExpression.Wink,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Sad",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewSad() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Idle,
            gaze = GazeOffset(),
            expression = FaceExpression.Sad,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Excited",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewExcited() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Speaking,
            gaze = GazeOffset(),
            expression = FaceExpression.Excited,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Angry",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewAngry() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Engaged,
            gaze = GazeOffset(),
            expression = FaceExpression.Angry,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Love",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewLove() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Speaking,
            gaze = GazeOffset(),
            expression = FaceExpression.Love,
            privacy = false,
        )
    }
}

@Preview(widthDp = 720, heightDp = 360, name = "Privacy",
    backgroundColor = 0xFF06090C, showBackground = true)
@Composable
private fun FacePreviewPrivacy() {
    NodeDockTheme {
        FaceRenderer(
            state = FaceState.Idle,
            gaze = GazeOffset(),
            expression = FaceExpression.Sleepy,
            privacy = true,
        )
    }
}
