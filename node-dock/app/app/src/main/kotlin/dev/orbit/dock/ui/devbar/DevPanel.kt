package dev.orbit.dock.ui.devbar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceExpression

/**
 * Debug-only inline test panel.
 *
 * Default layout when expanded:
 *
 *   [ ⌃ ]  [ ⟳ emotion ]    < tab content >
 *
 *   - `⌃` chevron toggles the whole panel (collapsed = single chevron row)
 *   - The "⟳ name" chip is the **cycle-tab** button. Tap to advance to
 *     the next tab (text → emotion → state → text). The chip label is the
 *     current tab name.
 *   - Tab content fills the rest of the row.
 *
 * Tabs (in priority of use):
 *   - TEXT     — transcript injector (Enter→Send)
 *   - EMOTION  — chips for all FaceExpressions (direct setExpression)
 *   - STATE    — chips for force-setting FaceState
 */
@Composable
fun DevPanel(controller: FaceController, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable { mutableStateOf(true) }
    // Default to the FACE picker — switching the dock's face is a first-class
    // thing you reach for; the other tabs are a ⟳ tap away.
    var tab by rememberSaveable { mutableStateOf(DevTab.FACE) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF1A2228).copy(alpha = 0.85f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ChevronToggle(expanded = expanded) { expanded = !expanded }
            if (expanded) {
                CycleTabButton(tab) { tab = it.next() }
                Box(modifier = Modifier.weight(1f)) {
                    when (tab) {
                        DevTab.TEXT -> TextTab()
                        DevTab.EMOTION -> EmotionTab(controller)
                        DevTab.FACE -> FaceTab(controller)
                        DevTab.STATE -> StateTab(controller)
                        DevTab.LLM -> LlmTab()
                        DevTab.DEBUG -> DebugTab()
                    }
                }
            }
        }
    }
}

private enum class DevTab(val label: String) {
    TEXT("text"),
    EMOTION("emotion"),
    FACE("face"),
    STATE("state"),
    LLM("llm"),
    DEBUG("debug");

    fun next(): DevTab = entries[(ordinal + 1) % entries.size]
}

@Composable
private fun ChevronToggle(expanded: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Color.White.copy(alpha = 0.07f))
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            if (expanded) "−" else "≡",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFFFBE5C),
        )
    }
}

@Composable
private fun CycleTabButton(tab: DevTab, onCycle: (DevTab) -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Color(0xFF2D3D49))
            .clickable { onCycle(tab) }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            "⟳ ${tab.label}",
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFF9DDDFF),
        )
    }
}

// ── TEXT ──────────────────────────────────────────────────────────────

@Composable
private fun TextTab() {
    var value by remember { mutableStateOf(TextFieldValue("")) }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    fun send() {
        val text = value.text.trim()
        if (text.isEmpty()) return
        PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(dev)"))
        PerceptionBus.emit(PerceptionEvent.Transcript(text = text, isFinal = true))
        value = TextFieldValue("")
        keyboard?.hide()
        focusManager.clearFocus(force = true)
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = { value = it },
            placeholder = {
                Text(
                    "type a transcript",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.4f),
                )
            },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium,
            modifier = Modifier
                .weight(1f)
                .height(44.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = MaterialTheme.colorScheme.onBackground,
                unfocusedTextColor = MaterialTheme.colorScheme.onBackground,
                focusedBorderColor = Color(0xFF9DDDFF).copy(alpha = 0.4f),
                unfocusedBorderColor = Color.White.copy(alpha = 0.12f),
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
        )
        TextButton(onClick = { send() }) { Text("go", fontSize = 12.sp) }
    }
}

// ── EMOTION ───────────────────────────────────────────────────────────

@Composable
private fun EmotionTab(controller: FaceController) {
    val scroll = rememberScrollState()
    val current by controller.expression.collectAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scroll),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (expr in FaceExpression.entries) {
            Chip(
                label = expr.name.lowercase(),
                selected = expr == current,
                onClick = { controller.setExpression(expr) },
            )
        }
        Chip(label = "wink!", onClick = { controller.wink() }, accent = true)
    }
}

// ── FACE ──────────────────────────────────────────────────────────────

@Composable
private fun FaceTab(controller: FaceController) {
    val scroll = rememberScrollState()
    val current by controller.faceId.collectAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scroll),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (face in dev.orbit.dock.ui.face.FaceRegistry.faces) {
            Chip(
                label = face.label.lowercase(),
                selected = face.id == current,
                onClick = { controller.setFaceStyle(face.id) },
            )
        }
    }
}

// ── DEBUG ─────────────────────────────────────────────────────────────

@Composable
private fun DebugTab() {
    val result by dev.orbit.dock.perception.AecTestState.result.collectAsState()
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Chip("run aec test", accent = true) {
            dev.orbit.dock.perception.PerceptionBus.emit(
                dev.orbit.dock.perception.PerceptionEvent.RunAecTest,
            )
        }
        val r = result
        val (text, color) = when (r?.outcome) {
            null -> "speaker ON, out loud → dock speaks, STT listens for echo" to
                MaterialTheme.colorScheme.onBackground.copy(alpha = 0.6f)
            dev.orbit.dock.perception.AecSelfTest.Outcome.RUNNING ->
                "speaking — listening for echo…" to Color(0xFFFFBE5C)
            dev.orbit.dock.perception.AecSelfTest.Outcome.PASS ->
                "PASS — STT heard nothing → AEC works" to Color(0xFF7CE38B)
            dev.orbit.dock.perception.AecSelfTest.Outcome.FAIL ->
                "FAIL — STT heard the dock: \"${r.heard}\"" to Color(0xFFFF7C7C)
            dev.orbit.dock.perception.AecSelfTest.Outcome.INCONCLUSIVE ->
                "no audio — turn volume up + retry (rms=%.2f)".format(r.peakRms) to
                    Color(0xFFFFBE5C)
        }
        Text(text, fontSize = 11.sp, color = color)
    }
}

// ── STATE ─────────────────────────────────────────────────────────────

@Composable
private fun StateTab(controller: FaceController) {
    val scroll = rememberScrollState()
    val current by controller.state.collectAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scroll),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Chip("idle", selected = current == dev.orbit.dock.ui.face.FaceState.Idle) { controller.silence() }
        Chip("wake", selected = current == dev.orbit.dock.ui.face.FaceState.Engaged) { controller.wake() }
        Chip("listen", selected = current == dev.orbit.dock.ui.face.FaceState.Listening) { controller.listen() }
        Chip("speak", selected = current == dev.orbit.dock.ui.face.FaceState.Speaking) { controller.speak() }
        Chip("illustrate", selected = current == dev.orbit.dock.ui.face.FaceState.Illustrating) { controller.illustrate() }
    }
}

// ── LLM ───────────────────────────────────────────────────────────────

@Composable
private fun LlmTab() {
    val turn by dev.orbit.dock.agent.TurnLog.current.collectAsState()
    val scroll = rememberScrollState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scroll),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (turn == null) {
            Text(
                "(no turns yet — say something or type in TEXT tab)",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.5f),
            )
            return@Row
        }
        val t = turn!!
        StatPill("⏱", t.latencyMs?.let { "${it}ms" } ?: "…")
        StatPill("🤖", t.winningModel?.substringAfter('/')?.substringBefore(':') ?: "—")
        StatPill("attempts", t.attempts.size.toString())
        StatPill("tools", t.tools.size.toString())
        QuoteBox(label = "you", text = t.transcript)
        QuoteBox(label = "bot", text = t.reply ?: "(no reply yet)")
        if (t.tools.isNotEmpty()) {
            val toolStr = t.tools.joinToString("  ") { tc ->
                "${tc.name}(${tc.arg?.take(24) ?: ""})"
            }
            QuoteBox(label = "calls", text = toolStr)
        }
        if (t.attempts.any { it.error != null }) {
            val failStr = t.attempts.filter { it.error != null }
                .joinToString("  ") { "${it.modelId.substringAfter('/').substringBefore(':')}: ${it.error?.take(40)}" }
            QuoteBox(label = "errors", text = failStr)
        }
    }
}

@Composable
private fun StatPill(label: String, value: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Color.White.copy(alpha = 0.06f))
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text(
            "$label $value",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.85f),
        )
    }
}

@Composable
private fun QuoteBox(label: String, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "$label: ",
            fontSize = 10.sp,
            color = Color(0xFFFFBE5C).copy(alpha = 0.9f),
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.85f),
            modifier = Modifier
                .padding(start = 2.dp, end = 4.dp),
        )
    }
}

// ── shared ────────────────────────────────────────────────────────────

@Composable
private fun Chip(
    label: String,
    accent: Boolean = false,
    selected: Boolean = false,
    onClick: () -> Unit,
) {
    val bg = when {
        selected -> Color(0xFF9DDDFF).copy(alpha = 0.22f)
        accent -> Color(0xFFFFBE5C).copy(alpha = 0.18f)
        else -> Color.White.copy(alpha = 0.08f)
    }
    val fg = when {
        selected -> Color(0xFF9DDDFF)
        accent -> Color(0xFFFFBE5C)
        else -> MaterialTheme.colorScheme.onBackground.copy(alpha = 0.85f)
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(bg)
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = fg,
        )
    }
}
