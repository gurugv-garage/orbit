package dev.orbit.dock.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.orbit.dock.agent.AgentState
import kotlin.math.max
import kotlin.math.sin

/**
 * Three pulsing dots shown while the agent is Thinking or ToolCalling.
 * Hidden in Idle / Speaking / Failed states — the subtitle covers those.
 */
@Composable
fun ThinkingDots(
    agentState: AgentState,
    modifier: Modifier = Modifier,
) {
    val visible = agentState is AgentState.Waiting ||
        agentState is AgentState.Thinking ||
        agentState is AgentState.ToolCalling
    if (!visible) return

    val color = when (agentState) {
        is AgentState.Waiting -> Color(0xFFC0C8D0)
        is AgentState.Thinking -> Color(0xFFFFD66B)
        is AgentState.ToolCalling -> Color(0xFF9DDDFF)
        else -> Color.Transparent
    }

    val transition = rememberInfiniteTransition(label = "dots")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = (Math.PI * 2).toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1200, easing = LinearEasing),
        ),
        label = "phase",
    )

    Canvas(modifier = modifier.size(width = 60.dp, height = 12.dp)) {
        val w = size.width
        val h = size.height
        val r = h * 0.32f
        val cy = h / 2f
        val gap = (w - r * 6f) / 4f
        for (i in 0..2) {
            val cx = gap + r + (gap + r * 2f) * i
            val offsetSin = sin(phase + i * 1.0f)
            val alpha = (0.4f + 0.6f * max(0f, offsetSin)).coerceIn(0f, 1f)
            drawCircle(
                color = color.copy(alpha = alpha),
                radius = r,
                center = Offset(cx, cy),
            )
        }
    }
}
