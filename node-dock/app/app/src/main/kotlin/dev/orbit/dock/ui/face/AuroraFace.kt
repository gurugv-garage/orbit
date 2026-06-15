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
import androidx.compose.ui.graphics.drawscope.rotate

/**
 * Aurora — the original dock face: soft floating baby-blue eyes with brows,
 * optional mouth, cheeks, halo, and accent overlays. This is the default face,
 * unchanged from the pre-pluggable-faces renderer (it now shares the animation
 * engine [rememberFaceFrame] + the [FacePrimitives] kit).
 *
 * Also the reference implementation for "an eye-based face": copy this, swap the
 * palette + add/remove decorations.
 */
object AuroraFace : Face {
    override val id = "aurora"
    override val label = "Aurora"
    override val voice = VoiceProfile(pitch = 1.05f, rate = 1.0f)
    override val palette = FacePalette()  // defaults == original DockPalette

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
            modifier = modifier,
            state = state,
            gaze = gaze,
            expression = expression,
            privacy = privacy,
            eyesClosed = eyesClosed,
            compactFraction = compactFraction,
            staticForScreenshot = staticForScreenshot,
            palette = palette,
            slitPupil = false,
        )
    }
}

/**
 * The shared "two-eyes-with-mood" renderer. Aurora, Puppy, Owl and Dragon all
 * draw their *base* eyes/brows/mouth/accents through this, then overlay their own
 * extra parts (ears, horns, …) by passing [overlay] / [behind] draw callbacks.
 *
 *  - [behind]   draws under the eyes (e.g. a body/head shape)
 *  - [overlay]  draws over the eyes (e.g. ears, whiskers, horns)
 *
 * Both callbacks receive the geometry so faces can anchor parts to the eyes.
 */
@Composable
@Suppress("LongParameterList")
internal fun DrawEyeFace(
    modifier: Modifier,
    state: FaceState,
    gaze: GazeOffset,
    expression: FaceExpression,
    privacy: Boolean,
    eyesClosed: Boolean,
    compactFraction: Float,
    staticForScreenshot: Boolean,
    palette: FacePalette,
    slitPupil: Boolean = false,
    behind: (androidx.compose.ui.graphics.drawscope.DrawScope.(EyeGeometry) -> Unit)? = null,
    overlay: (androidx.compose.ui.graphics.drawscope.DrawScope.(EyeGeometry) -> Unit)? = null,
) {
    val frame = rememberFaceFrame(state, expression, privacy, eyesClosed, staticForScreenshot)
    val baseColor by animateColorAsState(
        targetValue = currentEyeColor(state, expression, privacy, palette),
        animationSpec = tween(600, easing = EaseInOutCubic),
        label = "eye-color",
    )

    val shape = frame.shape
    Box(modifier = modifier.fillMaxSize()) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val centerY = h * 0.5f

            val baseEyeRadius = (minOf(w, h) * 0.18f) * compactFraction
            val effBreath = if (frame.staticForScreenshot) 0.5f else frame.breath
            val breathScale = 0.965f + effBreath * 0.07f
            val r = baseEyeRadius * breathScale

            val thinkX = -frame.thinkingPull * r * 0.18f
            val thinkY = -frame.thinkingPull * r * 0.14f
            val gazeX = gaze.x * r * 0.34f + frame.driftX + frame.microX * r * 0.06f + thinkX
            val gazeY = gaze.y * r * 0.34f + frame.driftY + frame.microY * r * 0.05f + thinkY +
                shape.gazeYBias * r

            val eyeGap = baseEyeRadius * 1.7f
            val leftCenter = Offset(w * 0.5f - eyeGap, centerY)
            val rightCenter = Offset(w * 0.5f + eyeGap, centerY)

            val geom = EyeGeometry(
                leftCenter = leftCenter, rightCenter = rightCenter,
                eyeRadius = r, baseEyeRadius = baseEyeRadius, centerX = w * 0.5f, centerY = centerY,
                color = baseColor, privacy = privacy,
            )

            rotate(degrees = shape.tiltDeg, pivot = Offset(w * 0.5f, centerY)) {
                behind?.invoke(this, geom)

                if (frame.halo > 0.01f) {
                    drawHalo(leftCenter, baseEyeRadius * 2.3f, frame.halo, palette.eyeGlow)
                    drawHalo(rightCenter, baseEyeRadius * 2.3f, frame.halo, palette.eyeGlow)
                }
                if (frame.cheek > 0.01f) {
                    val cheekY = centerY + r * 1.9f
                    drawCheek(Offset(leftCenter.x, cheekY), r * 0.65f, frame.cheek, palette.cheek)
                    drawCheek(Offset(rightCenter.x, cheekY), r * 0.65f, frame.cheek, palette.cheek)
                }

                val isWink = expression == FaceExpression.Wink
                val leftLid = frame.lid.coerceAtMost(shape.lidClamp)
                val rightLid = frame.lid.coerceAtMost(shape.lidClamp)

                val leftR = r * (1f - shape.asymmetry * 0.5f)
                val rightR = r * (1f + shape.asymmetry * 0.5f)

                val winkBoostX = if (isWink) 1.15f else 1f
                val winkBoostY = if (isWink) 1.15f else 1f
                val winkPupil = if (isWink) 1.2f else 1f

                if (isWink) {
                    drawWinkedEye(leftCenter, leftR * shape.eyeScaleX, leftR * 0.5f, baseColor)
                } else {
                    drawEye(
                        center = leftCenter, radius = leftR, lidOpen = leftLid,
                        gazeX = gazeX, gazeY = gazeY,
                        pupilDilate = frame.pupilDilate * shape.pupilScale,
                        color = baseColor, eyeScaleX = shape.eyeScaleX, eyeScaleY = shape.eyeScaleY,
                        lidBottomCurve = shape.lidBottomCurve, lidTopCurveInner = shape.lidTopCurveInner,
                        isLeft = true, expression = expression, palette = palette, slitPupil = slitPupil,
                    )
                }
                drawEye(
                    center = rightCenter, radius = rightR, lidOpen = rightLid,
                    gazeX = gazeX, gazeY = gazeY,
                    pupilDilate = frame.pupilDilate * shape.pupilScale * winkPupil,
                    color = baseColor, eyeScaleX = shape.eyeScaleX * winkBoostX,
                    eyeScaleY = shape.eyeScaleY * winkBoostY,
                    lidBottomCurve = shape.lidBottomCurve, lidTopCurveInner = shape.lidTopCurveInner,
                    isLeft = false, expression = expression, palette = palette, slitPupil = slitPupil,
                )

                if (frame.targetShape.mouthKind != MOUTH_NONE && !privacy && shape.mouthOpen > 0.02f) {
                    val mouthCenter = Offset(w * 0.5f, centerY + r * 2.1f)
                    // Talking: grow the mouth with the speaking chatter so it
                    // visibly moves while the dock talks.
                    val talk = 1f + frame.mouthChatter * 0.7f
                    drawMouth(
                        center = mouthCenter, size = r * 0.85f * shape.mouthOpen * talk,
                        kind = frame.targetShape.mouthKind,
                        color = palette.onBackground.copy(alpha = 0.92f), cheek = palette.cheek,
                    )
                }

                if (frame.targetShape.accent != ACCENT_NONE && !privacy) {
                    drawAccent(frame.targetShape.accent, leftCenter, rightCenter, r, palette)
                }

                if (shape.browShow > 0.01f && !privacy) {
                    val browColor = palette.onBackground.copy(alpha = 0.95f * shape.browShow)
                    drawBrow(
                        eyeCenter = leftCenter, eyeRx = r * shape.eyeScaleX * (1f - shape.asymmetry * 0.5f),
                        eyeRy = r * shape.eyeScaleY, innerY = shape.browInnerY, outerY = shape.browOuterY,
                        tilt = shape.browTilt, thick = shape.browThick * r * 0.10f, arch = shape.browArch,
                        isLeft = true, color = browColor,
                    )
                    drawBrow(
                        eyeCenter = rightCenter, eyeRx = r * shape.eyeScaleX * (1f + shape.asymmetry * 0.5f),
                        eyeRy = r * shape.eyeScaleY, innerY = shape.browInnerY, outerY = shape.browOuterY,
                        tilt = -shape.browTilt, thick = shape.browThick * r * 0.10f, arch = shape.browArch,
                        isLeft = false, color = browColor,
                    )
                }

                overlay?.invoke(this, geom)
            }
        }
    }
}

/** Geometry handed to a face's [DrawEyeFace] overlay/behind callbacks so it can
 *  anchor extra parts (ears, horns, snout…) relative to the eyes. */
internal data class EyeGeometry(
    val leftCenter: Offset,
    val rightCenter: Offset,
    val eyeRadius: Float,      // current breathing radius
    val baseEyeRadius: Float,  // pre-breath radius
    val centerX: Float,
    val centerY: Float,
    val color: androidx.compose.ui.graphics.Color,
    val privacy: Boolean,
)

/** Compatibility shim: the old top-level `FaceRenderer(...)` entrypoint, now an
 *  alias for the Aurora face. Kept so existing call sites + @Preview compile. */
@Composable
fun FaceRenderer(
    modifier: Modifier = Modifier,
    state: FaceState,
    gaze: GazeOffset,
    expression: FaceExpression,
    privacy: Boolean,
    eyesClosed: Boolean = false,
    compactFraction: Float = 1f,
    staticForScreenshot: Boolean = false,
) {
    AuroraFace.Render(
        modifier = modifier,
        state = state,
        gaze = gaze,
        expression = expression,
        privacy = privacy,
        eyesClosed = eyesClosed,
        compactFraction = compactFraction,
        staticForScreenshot = staticForScreenshot,
    )
}
