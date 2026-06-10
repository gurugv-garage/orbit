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
    var tab by rememberSaveable { mutableStateOf(DevTab.TEXT) }

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
                        DevTab.STATE -> StateTab(controller)
                        DevTab.LLM -> LlmTab()
                        DevTab.BODY -> BodyTab()
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
    STATE("state"),
    LLM("llm"),
    BODY("body"),
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

// ── BODY ──────────────────────────────────────────────────────────────
// Hardware test controls. Drives BodyLinkComms directly (bypasses the LLM
// agent) so we can prove the wire protocol + heartbeat against the live
// XIAO or sim without saying "hey jarvis, look up" first.
//
// Bigger chips + always-visible status line. Renders the BODY tab as a
// proper two-row UI: a row of big tappable chips, then a status line
// showing the last command's phase (waiting / moving / settled / no_ack)
// per part.

@Composable
private fun BodyTab() {
    val scope = rememberCoroutineScope()
    val comms = dev.orbit.dock.body.ui.BodyTestController.comms
    val connected by (comms?.connected
        ?: kotlinx.coroutines.flow.MutableStateFlow(false)).collectAsState()
    val intent by (comms?.intent
        ?: kotlinx.coroutines.flow.MutableStateFlow(dev.orbit.dock.body.BodyIntent.EMPTY)
        ).collectAsState()
    val scroll = rememberScrollState()

    if (comms == null) {
        Text(
            "(no BodyLink — set BODY_HOST in local.properties)",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.5f),
        )
        return
    }

    fun send(part: String, state: String) {
        scope.launch { comms.setState(part, state) }
    }
    fun raw(part: String, us: Long, ms: Int) {
        scope.launch {
            comms.setTarget(mapOf(part to mapOf("pulse_width_us" to us.toDouble())), durationMs = ms)
        }
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        // Row 1: status line, prominent — shows live intent per part.
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BigStatusPill(if (connected) "●" else "○",
                          if (connected) "connected" else "disconnected",
                          accent = connected)
            if (intent.parts.isEmpty()) {
                Text(
                    "(tap a chip below to drive the body)",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.55f),
                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                )
            } else {
                for ((p, pi) in intent.parts) {
                    PhasePill(part = p, intent = pi)
                }
            }
        }
        // Row 2: BIG chips.
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(scroll),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BigChip("neck ↑") { send("neck", "lookUp") }
            BigChip("neck ↓") { send("neck", "lookDown") }
            BigChip("neck ◦") { send("neck", "center") }
            BigChip("foot ←") { send("foot", "left") }
            BigChip("foot ◦") { send("foot", "forward") }
            BigChip("foot →") { send("foot", "right") }
            BigChip("HOME", accent = true) {
                send("neck", "center"); send("foot", "forward")
            }
            BigChip("OOR!", accent = true) { raw("neck", 9999, 200) }
        }
    }
}

@Composable
private fun BigChip(label: String, accent: Boolean = false, onClick: () -> Unit) {
    val bg = if (accent) Color(0xFFFFBE5C).copy(alpha = 0.22f)
             else Color(0xFF9DDDFF).copy(alpha = 0.16f)
    val fg = if (accent) Color(0xFFFFBE5C) else Color(0xFF9DDDFF)
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(bg)
            .clickable { onClick() }
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(
            label,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            color = fg,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
        )
    }
}

@Composable
private fun BigStatusPill(icon: String, label: String, accent: Boolean = false) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (accent) Color(0xFF1E5128).copy(alpha = 0.6f)
                else Color(0xFF512828).copy(alpha = 0.6f)
            )
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            "$icon $label",
            fontSize = 12.sp,
            color = Color.White,
            fontWeight = FontWeight.SemiBold,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
        )
    }
}

@Composable
private fun PhasePill(part: String, intent: dev.orbit.dock.body.PartIntent) {
    // Tick the clock while moving so the % updates live.
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(intent) {
        while (intent.phase == dev.orbit.dock.body.PartIntent.Phase.Moving && !intent.settled) {
            nowMs = System.currentTimeMillis()
            delay(80L)
        }
        nowMs = System.currentTimeMillis()
    }
    val (label, bg, fg) = when (intent.phase) {
        dev.orbit.dock.body.PartIntent.Phase.Waiting ->
            Triple("$part: ${intent.stateName ?: "?"} (waiting…)",
                   Color(0xFFFFBE5C).copy(alpha = 0.18f), Color(0xFFFFBE5C))
        dev.orbit.dock.body.PartIntent.Phase.Moving -> {
            val pct = (intent.progressAt(nowMs) * 100).toInt()
            Triple("$part: ${intent.stateName ?: "?"} ($pct%)",
                   Color(0xFF9DDDFF).copy(alpha = 0.18f), Color(0xFF9DDDFF))
        }
        dev.orbit.dock.body.PartIntent.Phase.Settled ->
            Triple("$part: ${intent.stateName ?: "?"} ✓",
                   Color(0xFF7BC97B).copy(alpha = 0.18f), Color(0xFF7BC97B))
        dev.orbit.dock.body.PartIntent.Phase.NoAck ->
            Triple("$part: NO_ACK!",
                   Color(0xFFFF7B7B).copy(alpha = 0.22f), Color(0xFFFF7B7B))
        dev.orbit.dock.body.PartIntent.Phase.Rejected ->
            Triple("$part: REJECTED",
                   Color(0xFFFF7B7B).copy(alpha = 0.22f), Color(0xFFFF7B7B))
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(bg)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            label,
            fontSize = 12.sp,
            color = fg,
            fontWeight = FontWeight.SemiBold,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
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
