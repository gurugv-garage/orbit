package dev.orbit.dock.ui.widgets

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.agent.ModelCatalog
import dev.orbit.dock.agent.ModelOption

/**
 * Tappable chip showing the active LLM; tap → a picker of the benchmarked
 * [ModelCatalog] models (the same five the report covers). Selecting one calls
 * [onSelect] (which persists + rebuilds the agent). Replaces the old static
 * "local / v0.3" widget so the brain is switchable at runtime.
 */
@Composable
fun ModelChip(
    selected: ModelOption,
    onSelect: (ModelOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.55f))
            .clickable { open = true }
            .padding(10.dp),
    ) {
        Text("model", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
        Text(
            selected.label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.9f),
        )
        Text(
            (if (selected.cloud) "cloud" else "local") + (if (selected.vision) " · 👁" else ""),
            fontSize = 9.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
    }

    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { open = false }) { Text("close") } },
            title = { Text("Choose model", fontSize = 16.sp) },
            text = {
                Column {
                    for (opt in ModelCatalog.OPTIONS) {
                        val active = opt.model == selected.model
                        Column(
                            modifier = Modifier
                                .clickable { onSelect(opt); open = false }
                                .padding(vertical = 8.dp),
                        ) {
                            Text(
                                (if (active) "● " else "○ ") + opt.label,
                                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                            )
                            Text(
                                (if (opt.cloud) "cloud" else "local") +
                                    (if (opt.vision) " · vision" else " · text-only"),
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                            )
                        }
                    }
                }
            },
        )
    }
}
