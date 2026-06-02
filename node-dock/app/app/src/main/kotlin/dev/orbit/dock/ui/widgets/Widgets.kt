package dev.orbit.dock.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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
