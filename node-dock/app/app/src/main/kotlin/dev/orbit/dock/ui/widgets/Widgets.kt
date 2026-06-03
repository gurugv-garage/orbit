package dev.orbit.dock.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * Placeholder for the left/right widget column.
 *
 * In v1 we ship two stub widgets per column. Future: user-configurable
 * widget slots (clock, calendar, weather, "now playing", custom).
 */
@Composable
fun WidgetColumn(
    items: List<String>,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .width(110.dp)
            .fillMaxHeight()
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (item in items) {
            WidgetCard(text = item)
        }
    }
}

/**
 * Small Exit affordance for the dock. Tap once to arm ("tap to exit"), tap
 * again within a few seconds to actually quit — so an accidental touch (or the
 * user's face, since the screen stays on) doesn't kill the dock. [onExit] does
 * the full teardown (service + notification + task).
 */
@Composable
fun ExitButton(onExit: () -> Unit, modifier: Modifier = Modifier) {
    var armed by remember { mutableStateOf(false) }
    // auto-disarm after a few seconds if not confirmed.
    LaunchedEffect(armed) {
        if (armed) { delay(3000); armed = false }
    }
    val accent = Color(0xFFFF7B7B)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(accent.copy(alpha = if (armed) 0.22f else 0.08f))
            .clickable { if (armed) onExit() else armed = true }
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text("⏻", fontSize = 13.sp, color = accent)
        if (armed) {
            Spacer(modifier = Modifier.width(6.dp))
            Text("tap to exit", fontSize = 11.sp, color = accent)
        }
    }
}

@Composable
private fun WidgetCard(text: String) {
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.55f))
            .padding(10.dp),
    ) {
        Text(
            text,
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f),
        )
    }
}
