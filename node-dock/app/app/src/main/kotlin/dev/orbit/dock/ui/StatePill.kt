package dev.orbit.dock.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.agent.AgentState
import dev.orbit.dock.ui.face.FaceState

/**
 * Single top-center pill that always shows what the dock is doing right now.
 *
 * Priority (most informative wins):
 *   1. Privacy mode — explicit "off" indication
 *   2. AgentState (Thinking / ToolCalling / Failed) — LLM/tool activity
 *   3. FaceState.Speaking + AgentState.Speaking — TTS audio
 *   4. FaceState.Engaged / Listening — STT capturing
 *   5. FaceState.Idle — passive "watching" (face cam alive) or "ready"
 */
@Composable
fun StatePill(
    faceState: FaceState,
    agentState: AgentState,
    privacy: Boolean,
    micGranted: Boolean,
    camGranted: Boolean,
    facePresent: Boolean,
    modifier: Modifier = Modifier,
) {
    val tone = resolveTone(faceState, agentState, privacy, micGranted, camGranted, facePresent)
    AnimatedContent(
        targetState = tone,
        transitionSpec = {
            fadeIn(tween(180)) togetherWith fadeOut(tween(180))
        },
        modifier = modifier,
        label = "state-pill",
    ) { t ->
        Pill(label = t.label, color = t.color, pulsing = t.pulsing)
    }
}

private data class PillTone(
    val label: String,
    val color: Color,
    val pulsing: Boolean,
)

private fun resolveTone(
    faceState: FaceState,
    agentState: AgentState,
    privacy: Boolean,
    micGranted: Boolean,
    camGranted: Boolean,
    facePresent: Boolean,
): PillTone = when {
    privacy -> PillTone("PRIVATE", Color(0xFF8A8A8A), false)
    !micGranted -> PillTone("MIC OFF", Color(0xFFFFBE5C), true)

    // Agent activity takes priority over face state during a turn.
    agentState is AgentState.Failed -> PillTone("ERROR", Color(0xFFFF5C5C), false)
    agentState is AgentState.Waiting -> PillTone("WAITING", Color(0xFFC0C8D0), true)
    agentState is AgentState.Thinking -> PillTone("THINKING", Color(0xFFFFD66B), true)
    agentState is AgentState.ToolCalling ->
        PillTone(agentState.name.uppercase().take(10), Color(0xFFB99CFF), true)

    // Speaking — bot is producing audio.
    agentState is AgentState.Speaking || faceState == FaceState.Speaking ->
        PillTone("SPEAKING", Color(0xFF7FB7FF), false)

    // Active listening — STT is engaged.
    faceState == FaceState.Engaged || faceState == FaceState.Listening ->
        PillTone("LISTENING", Color(0xFFFF7B7B), true)

    // Idle — face cam alive, eyes are tracking. Show "watching" vs "ready".
    camGranted && facePresent -> PillTone("WATCHING", Color(0xFF7FE08C), false)
    camGranted -> PillTone("READY", Color(0xFF7FE08C).copy(alpha = 0.7f), false)
    else -> PillTone("READY", Color(0xFF888888), false)
}

@Composable
private fun Pill(label: String, color: Color, pulsing: Boolean) {
    val transition = rememberInfiniteTransition(label = "pill-pulse")
    val alpha by transition.animateFloat(
        initialValue = if (pulsing) 0.35f else 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(700),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pill-alpha",
    )
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Color.Black.copy(alpha = 0.55f))
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(color.copy(alpha = if (pulsing) alpha else 1f)),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            label,
            color = Color.White,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 1.sp,
        )
    }
}
