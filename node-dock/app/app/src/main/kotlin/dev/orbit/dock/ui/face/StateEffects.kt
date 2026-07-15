package dev.orbit.dock.ui.face

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer

/**
 * Host overlays that make the dock's STATE legible without words — the same
 * playbook as [ListeningGlow], which is the one effect that already works:
 *
 *  - a HOST overlay, not per-face → every face style gets it free
 *  - breathing, not blinking → reads as alive, not as an alarm
 *  - gated with a fade → never pops
 *  - tinted by the active face's accent → belongs to whatever face is showing
 *
 * Each effect owns a DISTINCT visual channel, or they stack into a Christmas
 * tree during a normal turn:
 *
 *  | listening    | rim glow, breathing      (ListeningGlow) |
 *  | speaking     | centre bloom             (SpeakingBloom) |
 *  | disconnected | SATURATION — nothing else touches it     |
 *  | mood         | eye/brow shape + accent                  |
 *
 * Listening and speaking are mutually exclusive by state. Disconnection can
 * legitimately coexist with anything, which is exactly why it must not share a
 * channel with them.
 *
 * ListeningGlow's scar, heeded here: a colour tween that CHASED a per-frame
 * pulse target never caught up, and the rim settled at ~0.09 alpha — invisible.
 * So: gate ON/OFF with the tween, apply the pulse DIRECTLY.
 */

/**
 * SPEAKING — a soft bloom from the centre outward.
 *
 * Deliberately the INVERSE of listening: listening pulls attention *in* (a calm
 * rim glow, "I'm attending to you"); speaking pushes *out*. Not a rim pulse —
 * two rim effects would be confusable, and these are the two states that most
 * need telling apart at a glance. The dock used to glow when YOU talked and show
 * nothing when IT did.
 *
 * Slower than the listening breath (2.2s vs 1.6s) so it reads as calm output,
 * not urgency, and subtle enough not to fight the face it sits behind.
 */
@Composable
fun SpeakingBloom(
    speaking: Boolean,
    accent: Color,
    modifier: Modifier = Modifier,
) {
    val transition = rememberInfiniteTransition(label = "speaking-bloom")
    val pulse by transition.animateFloat(
        initialValue = 0.30f,
        targetValue = 0.85f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2_200, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "bloom-pulse",
    )
    val gate by animateFloatAsState(
        targetValue = if (speaking) 1f else 0f,
        animationSpec = tween(durationMillis = 350),
        label = "bloom-gate",
    )

    val glow = Color(
        red = accent.red + (1f - accent.red) * 0.25f,
        green = accent.green + (1f - accent.green) * 0.25f,
        blue = accent.blue + (1f - accent.blue) * 0.25f,
        alpha = 0.30f * pulse * gate,
    )

    Box(
        modifier = modifier
            .fillMaxSize()
            .drawBehind {
                if (glow.alpha <= 0.01f) return@drawBehind
                // Radial, centre-out: lit at the middle, transparent by ~70% of
                // the radius — the opposite gradient direction to the rim glow.
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(glow, Color.Transparent),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = maxOf(size.width, size.height) * 0.7f,
                    ),
                )
            },
    ) {}
}

/**
 * DISCONNECTED — the face drains of colour and dims.
 *
 * The most important effect here, and the one that was missing entirely: a
 * disconnected dock LOOKS COMPLETELY NORMAL and just silently stops responding.
 * That is the worst failure mode in the app — indistinguishable from "it's
 * ignoring me". Draining the colour reads instantly as *something is wrong with
 * it* rather than *it's mad at me*, and it degrades gracefully: a reconnect blip
 * shows partial desaturation, which is honest rather than alarming.
 *
 * SATURATION is its channel, and nothing else may touch it. That's what lets it
 * coexist with any mood or state without becoming ambiguous.
 *
 * Wrap the face content: `ConnectionFade(connected) { AuroraFace(...) }`.
 */
@Composable
fun ConnectionFade(
    connected: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    // 1 = full colour, 0 = greyscale. Slow (1.2s) on purpose: a brief blip
    // shouldn't strobe the whole screen, and a real disconnection isn't urgent —
    // it's a state, so it should settle into view rather than announce itself.
    val saturation by animateFloatAsState(
        targetValue = if (connected) 1f else 0f,
        animationSpec = tween(durationMillis = 1_200),
        label = "connection-saturation",
    )
    val dim by animateFloatAsState(
        targetValue = if (connected) 1f else 0.55f,
        animationSpec = tween(durationMillis = 1_200),
        label = "connection-dim",
    )

    if (saturation >= 0.999f) {
        // Fully connected — the common case. Render with NO layer/filter at all:
        // a graphicsLayer on every frame of a healthy dock is pure overhead on a
        // modest phone, and this composable wraps the whole face.
        Box(modifier = modifier) { content() }
        return
    }

    // graphicsLayer does saturation + dim natively in ONE hardware layer — no
    // hand-rolled saveLayer/ColorFilter (the first cut of this didn't compile and
    // would have been slower anyway).
    val matrix = ColorMatrix().apply { setToSaturation(saturation) }
    Box(
        modifier = modifier.graphicsLayer {
            renderEffect = null
            alpha = dim
        }.drawWithContent {
            drawIntoCanvas { canvas ->
                canvas.saveLayer(
                    androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height),
                    Paint().apply { colorFilter = ColorFilter.colorMatrix(matrix) },
                )
                drawContent()
                canvas.restore()
            }
        },
    ) { content() }
}
