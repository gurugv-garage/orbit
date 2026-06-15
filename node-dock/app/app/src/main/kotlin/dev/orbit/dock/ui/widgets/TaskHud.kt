package dev.orbit.dock.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.agent.DebugInfo

/**
 * Top-left debug HUD: the open SESSION id (short, easy to quote) and the
 * currently-running background TASKS. Ambient telemetry like [EventLog] — faint,
 * no heavy panel — so it doesn't fight the face. Empty when there's nothing to show.
 */
@Composable
fun TaskHud(info: DebugInfo, modifier: Modifier = Modifier) {
    if (info.sessionId.isEmpty() && info.tasks.isEmpty()) return
    Column(
        modifier = modifier
            .padding(6.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(Color.White.copy(alpha = 0.06f))
            .padding(horizontal = 10.dp, vertical = 7.dp)
            .widthIn(max = 260.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        if (info.sessionId.isNotEmpty()) {
            Text(
                "session ${info.sessionId}",
                fontSize = 11.sp,
                lineHeight = 13.sp,
                color = Color(0xFF7FB0E0).copy(alpha = 0.9f),
                maxLines = 1,
            )
        }
        if (info.tasks.isEmpty()) {
            Text(
                "no tasks running",
                fontSize = 9.sp, lineHeight = 11.sp,
                color = Color.White.copy(alpha = 0.35f),
                maxLines = 1,
            )
        } else {
            for (t in info.tasks) {
                val dot = if (t.state == "stuck") "⏸" else "▶"
                Text(
                    "$dot ${t.name} ${t.instanceId} ${t.state}",
                    fontSize = 9.sp, lineHeight = 11.sp,
                    color = Color(0xFF7FE08C).copy(alpha = 0.75f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
