package dev.orbit.dock.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceState
import kotlinx.coroutines.delay
import timber.log.Timber

/**
 * Dims the screen backlight when nobody's around and nothing's happened for a
 * while — a resting state for an always-on dock that otherwise burns the panel
 * at full brightness 24/7.
 *
 * "Activity" is anything that means a person is present or interacting:
 *  - a face in the camera frame (FaceSeen),
 *  - voice / audio above the wake threshold (VoiceActivity / loud AudioLevel),
 *  - any interaction turn — listening, speaking, engaged, or a wake tap.
 * Any of those resets the idle clock and snaps the screen back to full bright.
 * After [idleAfterMs] with none of them, the backlight fades to [dimBrightness].
 *
 * This drives the WINDOW backlight (window.attributes.screenBrightness), not a
 * UI overlay — so it actually saves power and reads as the panel dimming. It
 * leaves FLAG_KEEP_SCREEN_ON alone: the dock never sleeps, it just rests dark.
 */
@Composable
fun IdleDimmer(
    controller: FaceController,
    // 1 minute of no presence / interaction → dim.
    idleAfterMs: Long = 60_000L,
    // Resting backlight (0..1). Low but not black so the face is still faintly
    // visible and the panel obviously "asleep" rather than off.
    dimBrightness: Float = 0.03f,
) {
    val ctx = LocalContext.current
    // LocalContext is often a ContextThemeWrapper around the Activity, so a bare
    // `as? Activity` returns null and silently disables dimming. Unwrap it.
    val activity = remember(ctx) { ctx.findActivity() } ?: return
    // Mutable holder shared between the event collector (writes) and the
    // idle-tick loop (reads). A plain var in remember is fine — both run on the
    // composition's coroutines, no cross-thread access.
    val lastActivityMs = remember { longArrayOf(System.currentTimeMillis()) }
    val dimmed = remember { booleanArrayOf(false) }
    // Throttle the "what reset the idle clock" log so a 10 Hz signal storm
    // doesn't flood logcat — one line per reason per ~5s is enough to see
    // *why* the screen won't dim "when no one's around".
    val lastResetLogMs = remember { longArrayOf(0L) }
    // Sliding-window timestamps of recent SOFT (ambient) presence hints, per
    // kind. A single stray blip — one VAD false-positive on a room creak, one
    // flickered face detection — must NOT hold the screen awake; only a
    // sustained run does. See [markSoft].
    val softHits = remember { mutableMapOf<String, ArrayDeque<Long>>() }

    fun setBrightness(value: Float) {
        activity.window.attributes = activity.window.attributes.apply {
            screenBrightness = value
        }
    }

    fun bump(reason: String) {
        lastActivityMs[0] = System.currentTimeMillis()
        if (dimmed[0]) {
            dimmed[0] = false
            Timber.i("idle-dim: activity ($reason) → screen back to full bright")
            // BRIGHTNESS_OVERRIDE_NONE restores the user's/system brightness
            // rather than pinning us at full — the dock honors the device's
            // own auto/brightness setting when awake.
            setBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE)
        } else {
            val now = lastActivityMs[0]
            if (now - lastResetLogMs[0] >= 5_000L) {
                lastResetLogMs[0] = now
                Timber.i("idle-dim: clock reset by $reason")
            }
        }
    }

    // HARD signal — a genuine interaction (tap/wake, transcript, an active turn).
    // Resets the idle clock immediately; no debounce.
    fun markHard(reason: String) = bump(reason)

    // SOFT signal — an ambient presence HINT (raw VAD blip, single face frame)
    // that's prone to false positives. Only counts as presence once it's been
    // seen [softMinHits] times within the last [softWindowMs] — a lone blip never
    // reaches the bar, so an empty room finally goes quiet and dims, while a
    // person actually sitting there (steady face / real talking) keeps it lit.
    val softWindowMs = 12_000L
    val softMinHits = 4
    fun markSoft(reason: String) {
        val now = System.currentTimeMillis()
        val hits = softHits.getOrPut(reason) { ArrayDeque() }
        hits.addLast(now)
        while (hits.isNotEmpty() && now - hits.first() > softWindowMs) hits.removeFirst()
        if (hits.size >= softMinHits) bump("$reason×${hits.size}")
    }

    // Restore to system brightness if we leave the screen still dimmed.
    DisposableEffect(Unit) {
        onDispose {
            if (dimmed[0]) setBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE)
        }
    }

    // Presence / audio signals straight off the perception bus.
    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { ev ->
            when (ev) {
                // Soft hints — debounced. A single VAD blip on a room creak or a
                // one-frame face flicker is a false positive; require a sustained
                // run before it holds the screen awake (see markSoft).
                is PerceptionEvent.FaceSeen -> markSoft("face")
                is PerceptionEvent.VoiceActivity -> if (ev.active) markSoft("voice")
                // Hard signals — a real interaction, reset immediately.
                is PerceptionEvent.WakeWord -> markHard("wake:${ev.label}") // tap / debug
                is PerceptionEvent.Transcript -> markHard("transcript") // speech in progress
                else -> {}
            }
        }
    }

    // Interaction-by-face-state: anything that isn't a resting Idle counts as
    // active (Listening / Speaking / Engaged / Illustrating). This also covers
    // an in-flight brain turn, since the face stays Listening through it.
    LaunchedEffect(controller) {
        controller.state.collect { s ->
            if (s != FaceState.Idle) markHard("state:$s")
        }
    }

    // The idle tick: once per few seconds, dim if we've been quiet long enough.
    LaunchedEffect(idleAfterMs, dimBrightness) {
        Timber.i("idle-dim: armed (idleAfter=${idleAfterMs}ms dim=$dimBrightness)")
        while (true) {
            delay(3_000L)
            val quietFor = System.currentTimeMillis() - lastActivityMs[0]
            if (!dimmed[0] && quietFor >= idleAfterMs) {
                dimmed[0] = true
                Timber.i("idle-dim: quiet for ${quietFor}ms → dimming screen to $dimBrightness")
                setBrightness(dimBrightness)
            }
        }
    }
}

/** Unwrap an Activity from a (possibly themed) Compose context. */
private fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
