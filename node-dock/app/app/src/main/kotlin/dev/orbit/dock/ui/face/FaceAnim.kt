package dev.orbit.dock.ui.face

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseInOutCubic
import androidx.compose.animation.core.EaseOutCubic
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.delay
import kotlin.random.Random

/** Face redraw cadence (~30 fps). The continuous breathing/drift doesn't need
 *  60 fps; capping halves the frames pushed, easing GPU/compositor load on weak
 *  devices (Snapdragon 636) where 60 fps full-screen redraw + the camera
 *  SurfaceView overruns the frame budget. */
private const val FACE_ANIM_FRAME_MS = 33L

/**
 * The resolved per-frame animation state shared by eye-based faces. Produced by
 * [rememberFaceFrame]: it runs the blink / breath / micro-saccade / drift /
 * pupil-dilation / halo / cheek / expression-tween machine (formerly inlined in
 * the monolithic FaceRenderer) so each face only has to *draw*.
 *
 * `gazeXBase`/`gazeYBase` are the fully-composed eye-offset multipliers (gaze +
 * drift + micro-saccade + thinking pull + the expression's gaze bias); a face
 * multiplies them by its eye radius. `shape` is the tweened [ExpressionShape].
 */
internal data class FaceFrame(
    val breath: Float,        // 0..1 breathing phase (smoothstepped)
    val driftX: Float,        // idle drift, in raw px-ish units (×6)
    val driftY: Float,
    val microX: Float,        // micro-saccade, -1..1
    val microY: Float,
    val thinkingPull: Float,  // 0..1, pulls gaze up-left while "thinking"
    val lid: Float,           // 0..1 eyelid open fraction (blink)
    val pupilDilate: Float,
    val halo: Float,          // 0..1.4
    val cheek: Float,         // 0..1
    /** Mouth open fraction (0..1) while SPEAKING — a synthesized chatter, since
     *  Android TTS gives no live amplitude. 0 when not speaking. Faces multiply
     *  their open mouth height by this for a talking animation. */
    val mouthChatter: Float,
    val shape: ExpressionShape,       // tweened — use for continuous fields
    val targetShape: ExpressionShape, // settled target — use to gate discrete fields (mouthKind/accent)
    val staticForScreenshot: Boolean,
)

/**
 * Runs the face animation state machine and returns the current [FaceFrame].
 * Pure animation — no drawing, no colours. Honours [staticForScreenshot] by
 * pinning every animated value to a neutral, deterministic pose.
 */
@Composable
internal fun rememberFaceFrame(
    state: FaceState,
    expression: FaceExpression,
    privacy: Boolean,
    eyesClosed: Boolean,
    staticForScreenshot: Boolean,
): FaceFrame {
    val lidsClosed = privacy || eyesClosed

    val breathPeriod = when (expression) {
        FaceExpression.Excited -> 2200
        FaceExpression.Sleepy -> 6500
        else -> 4200
    }

    // Throttled wall-clock animation clock (~30 fps).
    val animClockMs = remember { mutableLongStateOf(0L) }
    LaunchedEffect(staticForScreenshot) {
        if (staticForScreenshot) { animClockMs.longValue = breathPeriod / 2L; return@LaunchedEffect }
        val startNanos = withFrameNanos { it }
        var lastEmit = -FACE_ANIM_FRAME_MS
        while (true) {
            val elapsedMs = (withFrameNanos { it } - startNanos) / 1_000_000L
            if (elapsedMs - lastEmit >= FACE_ANIM_FRAME_MS) {
                lastEmit = elapsedMs
                animClockMs.longValue = elapsedMs
            }
        }
    }
    val tMs = animClockMs.longValue
    val breath = run {
        val phase = (tMs % breathPeriod).toFloat() / breathPeriod
        val tri = if (phase < 0.5f) phase * 2f else (1f - phase) * 2f
        tri * tri * (3f - 2f * tri)
    }
    val driftPhase = ((tMs % 9000L).toFloat() / 9000f) * (Math.PI * 2).toFloat()
    val driftX = if (state == FaceState.Idle && !staticForScreenshot) kotlin.math.cos(driftPhase) * 6f else 0f
    val driftY = if (state == FaceState.Idle && !staticForScreenshot) kotlin.math.sin(driftPhase * 1.27f) * 4f else 0f

    // Blink / lid.
    val lid = remember { Animatable(1f) }
    LaunchedEffect(lidsClosed, expression, staticForScreenshot) {
        if (staticForScreenshot) {
            if (lidsClosed) lid.snapTo(0.18f) else lid.snapTo(1f)
            return@LaunchedEffect
        }
        if (lidsClosed) {
            lid.animateTo(0.05f, tween(280, easing = EaseInOutCubic))
        } else {
            if (lid.value < 0.95f) lid.animateTo(1f, tween(280, easing = EaseOutCubic))
            while (true) {
                val baseWait = (2200..6500).random()
                val scale = if (expression == FaceExpression.Sleepy) 0.6f else 1f
                delay((baseWait * scale).toLong())
                if (lidsClosed) break
                lid.animateTo(0f, tween(130, easing = EaseInOutCubic))
                lid.animateTo(1f, tween(180, easing = EaseOutCubic))
                if (Random.nextFloat() < 0.18f) {
                    delay(110)
                    lid.animateTo(0f, tween(110, easing = EaseInOutCubic))
                    lid.animateTo(1f, tween(160, easing = EaseOutCubic))
                }
            }
        }
    }

    // Micro-saccades.
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
            microX = 0f; microY = 0f
        }
    }
    val microXAnim by animateFloatAsState(microX, tween(90, easing = EaseOutCubic), label = "microX")
    val microYAnim by animateFloatAsState(microY, tween(90, easing = EaseOutCubic), label = "microY")

    val thinkingActive = state == FaceState.Engaged
    val thinkingPull by animateFloatAsState(
        if (thinkingActive) 1f else 0f, tween(260, easing = EaseOutCubic), label = "thinking",
    )

    val pupilTarget = when (state) {
        FaceState.Engaged -> 1.45f
        FaceState.Listening -> 1.28f
        FaceState.Speaking -> 1.12f
        FaceState.Illustrating -> 0.95f
        FaceState.Idle -> 1.0f
    }
    val pupilDilate by animateFloatAsState(pupilTarget, tween(240, easing = EaseOutCubic), label = "pupil")

    val haloStateTarget = when (state) {
        FaceState.Engaged -> 1f
        FaceState.Listening -> 0.85f
        FaceState.Speaking -> 0.7f
        FaceState.Illustrating, FaceState.Idle -> 0.4f
    }
    val targetShape = shapeFor(expression)
    val haloTarget = (haloStateTarget * targetShape.haloMul).coerceIn(0f, 1.4f)
    val halo by animateFloatAsState(
        if (privacy) 0f else haloTarget, tween(360, easing = EaseInOutCubic), label = "halo",
    )

    val cheekTarget = when {
        state == FaceState.Speaking -> 1f
        targetShape.cheekAlwaysOn -> 0.85f
        else -> 0f
    }
    val cheek by animateFloatAsState(cheekTarget, tween(420, easing = EaseOutCubic), label = "cheek")

    // Single coordinated expression transition (lerp every field on one clock).
    val fromShape = remember { mutableStateOf(targetShape) }
    val toShape = remember { mutableStateOf(targetShape) }
    val progress = remember { Animatable(0f) }
    LaunchedEffect(targetShape) {
        fromShape.value = lerpExpressionShape(fromShape.value, toShape.value, progress.value)
        toShape.value = targetShape
        progress.snapTo(0f)
        progress.animateTo(1f, tween(280, easing = EaseInOutCubic))
    }
    val shape = lerpExpressionShape(fromShape.value, toShape.value, progress.value)

    // Talking mouth: while Speaking, oscillate the mouth open/closed. Two
    // sine waves at incommensurate rates + a floor make it read as natural
    // speech chatter rather than a metronome. No real lip-sync (TTS has no
    // amplitude); this is the standard "yapping" animation. Static for
    // screenshots so the gallery is deterministic.
    val mouthChatter = if (state == FaceState.Speaking && !staticForScreenshot && !privacy) {
        val a = kotlin.math.sin(tMs / 95.0)
        val b = kotlin.math.sin(tMs / 57.0 + 1.3)
        (0.35f + 0.5f * (0.5f + 0.5f * ((a + b) / 2f)).toFloat()).coerceIn(0f, 1f)
    } else 0f

    return FaceFrame(
        breath = breath,
        driftX = driftX,
        driftY = driftY,
        microX = if (staticForScreenshot) 0f else microXAnim,
        microY = if (staticForScreenshot) 0f else microYAnim,
        thinkingPull = thinkingPull,
        lid = lid.value,
        pupilDilate = pupilDilate,
        halo = halo,
        cheek = cheek,
        mouthChatter = mouthChatter,
        shape = shape,
        targetShape = targetShape,
        staticForScreenshot = staticForScreenshot,
    )
}
