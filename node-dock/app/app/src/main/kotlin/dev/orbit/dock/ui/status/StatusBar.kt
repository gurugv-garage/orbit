package dev.orbit.dock.ui.status

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
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
    /** mic is on AND the audio actually reaches the station (WebRTC stream up). While
     *  false-but-micOn, the mic icon pulses dim ("connecting") — so the user doesn't
     *  talk into the post-restart dead window before the stream is delivering audio. */
    micReady: Boolean = true,
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
            micOn = micOn, micReady = micReady, camOn = camOn,
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
    micReady: Boolean,
    camOn: Boolean,
    onMicClick: (() -> Unit)? = null,
    onCamClick: (() -> Unit)? = null,
) {
    // mic on but stream not yet delivering to the station → "connecting" (pulse, amber,
    // trailing … ). Solid green only once the station is actually receiving audio, so
    // the user knows when it's safe to talk (fixes the lost-first-sentence-after-restart).
    val connecting = micOn && !micReady
    Row(verticalAlignment = Alignment.CenterVertically) {
        ToggleIcon(
            label = if (connecting) "mic…" else "mic",
            icon = if (micOn) "🎤" else "🚫",
            on = micOn,
            color = when {
                !micOn -> Color(0xFFFF7B7B)      // off → red
                connecting -> Color(0xFFFFBE5C)  // on, not ready → amber
                else -> Color(0xFF7FE08C)        // ready → green
            },
            pulsing = connecting,
            onClick = onMicClick,
        )
        Spacer(modifier = Modifier.width(8.dp))
        ToggleIcon(
            label = "cam",
            icon = if (camOn) "📷" else "🚫",
            on = camOn,
            color = if (camOn) Color(0xFF7FE08C) else Color(0xFFFF7B7B),
            onClick = onCamClick,
        )
    }
}

@Composable
private fun ToggleIcon(
    label: String,
    icon: String,
    on: Boolean,
    color: Color,
    pulsing: Boolean = false,
    onClick: (() -> Unit)?,
) {
    // While pulsing ("connecting"), breathe the whole chip's alpha so it reads as
    // not-yet-ready without adding a separate spinner.
    val pulseAlpha by rememberInfiniteTransition(label = "micPulse").animateFloat(
        initialValue = 0.35f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "micPulseAlpha",
    )
    // Hit target: the visible chip is small (icon + label, 3dp vertical padding), which
    // made the mic/cam toggle need several taps. The CLICKABLE region is enlarged to the
    // 48dp Android minimum (sizeIn + center) WITHOUT growing the visible chip — the
    // background/clip stay on the inner content, the touch area is the outer Box.
    val inner = Modifier
        .clip(RoundedCornerShape(50))
        .background(color.copy(alpha = 0.10f))
        .let { if (pulsing) it.alpha(pulseAlpha) else it }
        .padding(horizontal = 8.dp, vertical = 3.dp)
    Box(
        modifier = Modifier
            .let { if (onClick != null) it.clickable { onClick() } else it }
            .sizeIn(minWidth = 48.dp, minHeight = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = inner) {
            Text(icon, fontSize = 12.sp)
            Spacer(modifier = Modifier.width(4.dp))
            Text(label, fontSize = 11.sp, color = color)
        }
    }
}

