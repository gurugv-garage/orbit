package dev.orbit.dock.body.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.body.BodyIntent
import dev.orbit.dock.body.PartIntent
import kotlinx.coroutines.delay

/**
 * Compact corner indicator. Shows whether BodyLink is connected and the
 * brain's current intent per part. While a part is mid-transition, shows
 * "stateName (XX%)" — progress is computed locally from PartIntent.sentAt
 * since the body no longer streams state.
 */
@Composable
fun BodyBadge(
    connected: Boolean,
    intent: BodyIntent,
    modifier: Modifier = Modifier,
    onTap: (() -> Unit)? = null,
) {
    val bg = if (connected) Color(0xFF1E5128).copy(alpha = 0.85f)
             else Color(0xFF512828).copy(alpha = 0.65f)

    // Tick at 10 Hz to keep the progress label live; cheap, single Text.
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(intent) {
        while (intent.parts.values.any { !it.settled }) {
            nowMs = System.currentTimeMillis()
            delay(100L)
        }
        nowMs = System.currentTimeMillis()
    }

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(bg)
            // Tap opens the connect dialog. CRITICAL: use a consuming
            // pointerInput so the tap does NOT bubble to the dock screen's
            // outer wake/listen tap handler. detectTapGestures consumes the
            // event in the Main pass, so the parent's detectTapGestures never
            // sees it.
            .let { m ->
                if (onTap != null) m.pointerInput(Unit) {
                    detectTapGestures(onTap = { onTap() })
                } else m
            }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            text = if (connected) "● body" else "○ body",
            color = Color.White,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
        )
        if (connected) {
            for ((pname, ps) in intent.parts) {
                Text(
                    text = "  $pname: ${formatIntent(ps, nowMs)}",
                    color = Color.White.copy(alpha = 0.9f),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

private fun formatIntent(p: PartIntent, now: Long): String {
    val label = p.stateName ?: "<raw>"
    return when (p.phase) {
        PartIntent.Phase.Waiting -> "$label (waiting…)"
        PartIntent.Phase.NoAck   -> "$label (no_ack!)"
        PartIntent.Phase.Rejected -> "$label (rejected)"
        PartIntent.Phase.Moving -> if (p.settled) label
                                   else "$label (${(p.progressAt(now) * 100).toInt()}%)"
        PartIntent.Phase.Settled -> label
    }
}
