package dev.orbit.dock.ui.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.SharedFlow

/**
 * Live, transparent scrolling log of the agent's emitted loop events — replaces
 * the old "no events" placeholder. Each emitted line (from [dev.orbit.dock.agent.RemoteBrain.events],
 * e.g. "+812ms TOOL_START move_body{...}") appends at the bottom and the view
 * auto-scrolls, like a tail -f. No card background — just faint monospace text
 * over the face so it reads as ambient telemetry, not a panel.
 */
@Composable
fun EventLog(
    events: SharedFlow<String>,
    modifier: Modifier = Modifier,
    max: Int = 60,
) {
    var lines by remember { mutableStateOf(listOf<String>()) }
    LaunchedEffect(events) {
        // replayed history arrives first, then live lines.
        events.collect { line -> lines = (lines + line).takeLast(max) }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(lines.size) {
        if (lines.isNotEmpty()) listState.animateScrollToItem(lines.lastIndex)
    }

    Column(
        modifier = modifier.width(280.dp).padding(6.dp),
        verticalArrangement = Arrangement.Bottom,
    ) {
        // userScrollEnabled=false: this is an ambient tail -f, scrolled PROGRAMMATICALLY
        // (animateScrollToItem above). A scrollable LazyColumn would otherwise consume
        // pointer events across its 280dp-wide full-height area — a dead zone for the
        // screen-wide tap-to-listen gesture behind it. Disabling user-scroll lets taps
        // fall through to the listen gesture while the auto-scroll still works.
        LazyColumn(state = listState, userScrollEnabled = false) {
            items(lines) { line ->
                Text(
                    line,
                    fontSize = 9.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.42f),
                    // wrap so tool params (e.g. remember_face{name:guru}) aren't cut off.
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
