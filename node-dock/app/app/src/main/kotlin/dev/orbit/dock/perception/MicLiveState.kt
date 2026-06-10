package dev.orbit.dock.perception

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import timber.log.Timber

/**
 * Ground-truth microphone state, straight from Android's audio framework —
 * **not** our own model of what the mic *should* be doing.
 *
 * The UI's mic badge used to reflect inferred state (the user mute toggle + the
 * TTS echo gate), which drifted from reality. This observes the OS's actual
 * recording sessions via [AudioManager.registerAudioRecordingCallback] (push,
 * no polling — effectively free) and reports whether the mic is genuinely
 * **capturing and not silenced**:
 *
 *  - `capturing` — at least one active recording session exists for this app.
 *  - `silenced`  — the framework has muted our capture even though a session is
 *    open (privacy mute, another app grabbed it, system mic mute). API 29+.
 *
 * So `live = capturing && !silenced` is "sound is actually reaching us right
 * now". With WebRTC AEC the mic stays capturing during TTS (so barge-in can
 * hear the user), so this will correctly show ON during the dock's own speech.
 */
class MicLiveState(context: Context) {
    private val appCtx = context.applicationContext
    private val audio = appCtx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _live = MutableStateFlow(false)
    /** True when the OS is actively capturing for us and not silencing it. */
    val live: StateFlow<Boolean> = _live.asStateFlow()

    private val callback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
            update(configs ?: audio.activeRecordingConfigurations)
        }
    }

    fun start() {
        // Deliver current state immediately, then react to changes.
        update(audio.activeRecordingConfigurations)
        audio.registerAudioRecordingCallback(callback, null)
    }

    fun stop() {
        try { audio.unregisterAudioRecordingCallback(callback) } catch (_: Throwable) {}
        _live.value = false
    }

    private fun update(configs: List<AudioRecordingConfiguration>) {
        // The configs list is *this app's* recording sessions (the framework
        // scopes it to the caller). Any non-silenced session → mic is live.
        val capturing = configs.isNotEmpty()
        val silenced = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            configs.isNotEmpty() && configs.all { it.isClientSilenced }
        } else {
            false // isClientSilenced unavailable pre-29; treat as not silenced.
        }
        val live = capturing && !silenced
        if (_live.value != live) {
            Timber.tag("MIC_STATE").d("live=$live (capturing=$capturing silenced=$silenced n=${configs.size})")
            _live.value = live
        }
    }
}
