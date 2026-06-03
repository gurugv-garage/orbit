package dev.orbit.dock.ui.status

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.ui.face.Speaker

/**
 * Always-visible bottom status bar.
 *
 * - VAD bar: live audio level [0..1]
 * - Speaker: who's currently producing audio
 * - Mic / cam: real states
 * - Link status: one sleek chip with BODY + STATION connection dots (real).
 *
 * `onWakeClick` is wired in debug builds only (callers gate the lambda).
 */
@Composable
fun StatusBar(
    audioLevel: Float,
    speaker: Speaker,
    micOn: Boolean,
    camOn: Boolean,
    bodyConnected: Boolean,
    stationConnected: Boolean,
    stationAddr: String = "",
    onMicToggle: (() -> Unit)? = null,
    onCamToggle: (() -> Unit)? = null,
    onWakeClick: (() -> Unit)? = null,
    onLinkClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        VadBar(level = audioLevel)
        SpeakerIndicator(speaker, onClick = onWakeClick)
        MicCamIndicator(
            micOn = micOn, camOn = camOn,
            onMicClick = onMicToggle, onCamClick = onCamToggle,
        )
        LinkStatus(
            bodyConnected = bodyConnected,
            stationConnected = stationConnected,
            stationAddr = stationAddr,
            onClick = onLinkClick,
        )
    }
}

/**
 * Unified connection chip: two labelled dots — body (ESP32) and station —
 * each green when up, amber when down. Replaces the old mock body + plat
 * indicators. Tap to open the connect dialog.
 */
@Composable
private fun LinkStatus(
    bodyConnected: Boolean,
    stationConnected: Boolean,
    stationAddr: String = "",
    onClick: (() -> Unit)? = null,
) {
    val mod = Modifier
        .clip(RoundedCornerShape(50))
        .background(Color.White.copy(alpha = 0.05f))
        .let { if (onClick != null) it.clickable { onClick() } else it }
        .padding(horizontal = 10.dp, vertical = 4.dp)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = mod) {
        LinkDot(label = "body", up = bodyConnected, sub = null)
        Spacer(modifier = Modifier.width(12.dp))
        // station: show the address when connected, "reconnecting…" when down.
        LinkDot(
            label = "station",
            up = stationConnected,
            sub = if (stationConnected) stationAddr.ifBlank { null } else "reconnecting…",
        )
    }
}

@Composable
private fun LinkDot(label: String, up: Boolean, sub: String? = null) {
    val color = if (up) Color(0xFF7FE08C) else Color(0xFFFFBE5C)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .height(7.dp)
                .width(7.dp)
                .clip(RoundedCornerShape(50))
                .background(color),
        )
        Spacer(modifier = Modifier.width(5.dp))
        // single line; any sub-text goes inline in brackets so the bar height
        // doesn't grow (e.g. "station (192.168.1.10:8099)").
        Text(
            if (sub != null) "$label ($sub)" else label,
            fontSize = 11.sp,
            color = color.copy(alpha = 0.95f),
        )
    }
}

@Composable
private fun VadBar(level: Float) {
    val bars = 8
    val lit = (level.coerceIn(0f, 1f) * bars).toInt()
    Row(verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until bars) {
            val on = i < lit
            val color = when {
                !on -> Color.White.copy(alpha = 0.08f)
                i < bars / 2 -> Color(0xFF7FE08C).copy(alpha = 0.85f)
                i < (bars * 3) / 4 -> Color(0xFFFFD66B).copy(alpha = 0.85f)
                else -> Color(0xFFFF7B7B).copy(alpha = 0.85f)
            }
            Box(
                modifier = Modifier
                    .height(if (on) 10.dp else 6.dp)
                    .width(4.dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(color),
            )
            if (i != bars - 1) Spacer(modifier = Modifier.width(2.dp))
        }
    }
}

@Composable
private fun SpeakerIndicator(speaker: Speaker, onClick: (() -> Unit)?) {
    val label = when (speaker) {
        Speaker.Silent -> "🤐 silent"
        Speaker.User -> "🧑 user"
        Speaker.Bot -> "🤖 bot"
        Speaker.Muted -> "🔇 muted"
    }
    val mod = if (onClick != null) {
        Modifier.clickable { onClick() }.padding(horizontal = 4.dp)
    } else {
        Modifier.padding(horizontal = 4.dp)
    }
    Text(
        label,
        color = MaterialTheme.colorScheme.onBackground,
        fontSize = 12.sp,
        modifier = mod,
    )
}

@Composable
private fun MicCamIndicator(
    micOn: Boolean,
    camOn: Boolean,
    onMicClick: (() -> Unit)? = null,
    onCamClick: (() -> Unit)? = null,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        ToggleIcon(
            label = "mic",
            icon = if (micOn) "🎤" else "🚫",
            on = micOn,
            onClick = onMicClick,
        )
        Spacer(modifier = Modifier.width(8.dp))
        ToggleIcon(
            label = "cam",
            icon = if (camOn) "📷" else "🚫",
            on = camOn,
            onClick = onCamClick,
        )
    }
}

@Composable
private fun ToggleIcon(
    label: String,
    icon: String,
    on: Boolean,
    onClick: (() -> Unit)?,
) {
    val activeColor = if (on) Color(0xFF7FE08C) else Color(0xFFFF7B7B)
    val mod = Modifier
        .clip(RoundedCornerShape(50))
        .background(activeColor.copy(alpha = 0.10f))
        .let { if (onClick != null) it.clickable { onClick() } else it }
        .padding(horizontal = 8.dp, vertical = 3.dp)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = mod) {
        Text(icon, fontSize = 12.sp)
        Spacer(modifier = Modifier.width(4.dp))
        Text(label, fontSize = 11.sp, color = activeColor)
    }
}

