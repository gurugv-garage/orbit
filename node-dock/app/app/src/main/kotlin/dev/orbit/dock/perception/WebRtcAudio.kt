package dev.orbit.dock.perception

import android.content.Context
import android.media.MediaRecorder
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule
import timber.log.Timber

/**
 * The dock's on-device audio engine, backed by WebRTC's **audio half** only —
 * no PeerConnection, no signaling, no server. We use WebRTC purely as a local
 * DSP front-end: a [JavaAudioDeviceModule] captures the mic through the device's
 * `VOICE_COMMUNICATION` path with **hardware AEC + noise suppression**, so the
 * mic no longer hears the dock's own TTS playback. That echo-cancelled audio is
 * what unlocks voice barge-in (the mic can stay live while the dock speaks).
 *
 * Processed mic frames arrive via [JavaAudioDeviceModule.SamplesReadyCallback]
 * as 10 ms PCM-16 mono chunks; [MicCapture] reframes them to the 512-sample
 * frames the rest of the pipeline expects.
 *
 * **Streaming-ready by design:** the shared [PeerConnectionFactory] native init
 * and the single [JavaAudioDeviceModule] live here, owned once. When we later
 * send audio/video to orbit-station, the PeerConnection + audio track attach to
 * *this* same factory/ADM — the clean, AEC'd capture is exactly what we'd want
 * to publish, so nothing here has to be torn up. We deliberately do NOT create a
 * PeerConnection or any network surface now.
 *
 * AEC reference: hardware AEC cancels against the device's playback HAL, so the
 * existing Android [android.speech.tts.TextToSpeech] playback is referenced
 * automatically as long as capture uses `VOICE_COMMUNICATION` — capture and
 * playback share the device's voice-comm path (the "same endpoint" rule). No
 * change to TTS routing is required.
 */
object WebRtcAudio {

    /** Mic frames are delivered to WebRTC's ADM at this rate (mono PCM-16). */
    const val SAMPLE_RATE = 16_000

    private var nativeInitialized = false
    private var adm: JavaAudioDeviceModule? = null

    /** A consumer of processed (AEC'd) mic frames as raw PCM-16 little-endian bytes. */
    fun interface FrameSink {
        fun onFrame(pcm16: ByteArray, sampleRate: Int)
    }

    @Volatile private var sink: FrameSink? = null

    /** One-time native library init for the WebRTC factory. Idempotent. */
    @Synchronized
    private fun ensureNativeInit(context: Context) {
        if (nativeInitialized) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions
                .builder(context.applicationContext)
                .createInitializationOptions(),
        )
        nativeInitialized = true
        Timber.d("WebRtcAudio native init done")
    }

    /**
     * Build (once) and start the audio device module recording, routing every
     * processed mic frame to [sink]. Safe to call repeatedly — only the first
     * call builds + starts; later calls just swap the sink.
     */
    @Synchronized
    fun startCapture(context: Context, sink: FrameSink) {
        this.sink = sink
        if (adm != null) {
            adm?.requestStartRecording()
            return
        }
        ensureNativeInit(context)

        val hwAec = JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported()
        val hwNs = JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported()
        Timber.i("WebRtcAudio: source=VOICE_COMMUNICATION hwAEC=$hwAec hwNS=$hwNs")

        val module = JavaAudioDeviceModule.builder(context.applicationContext)
            // VOICE_COMMUNICATION is the path the platform echo canceller knows
            // about — it references the device's playback (our TTS) to subtract.
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setSampleRate(SAMPLE_RATE)
            .setUseHardwareAcousticEchoCanceler(hwAec)
            .setUseHardwareNoiseSuppressor(hwNs)
            .setSamplesReadyCallback { samples ->
                // 10 ms mono PCM-16 frames, already AEC'd. Forward to the sink.
                this.sink?.onFrame(samples.data, samples.sampleRate)
            }
            .setAudioRecordErrorCallback(object : JavaAudioDeviceModule.AudioRecordErrorCallback {
                override fun onWebRtcAudioRecordInitError(msg: String) =
                    Timber.e("ADM record init error: $msg")
                override fun onWebRtcAudioRecordStartError(
                    code: JavaAudioDeviceModule.AudioRecordStartErrorCode,
                    msg: String,
                ) = Timber.e("ADM record start error: $code $msg")
                override fun onWebRtcAudioRecordError(msg: String) =
                    Timber.e("ADM record error: $msg")
            })
            .createAudioDeviceModule()

        adm = module
        module.requestStartRecording()
        Timber.d("WebRtcAudio capture started")
    }

    /**
     * Fully release the audio device module — not just stop the recording
     * thread. Releasing detaches the hardware AEC/NS audio effects and frees the
     * native AudioRecord, which is required so the **next** mic consumer
     * (Android SpeechRecognizer) gets a clean input path. Keeping the ADM alive
     * with `requestStopRecording()` left the AEC effect attached and starved
     * SpeechRecognizer of audio (it heard pure silence → "no match"). The next
     * [startCapture] rebuilds the ADM from scratch.
     */
    @Synchronized
    fun stopCapture() {
        sink = null
        adm?.let {
            try { it.requestStopRecording() } catch (_: Throwable) {}
            try { it.release() } catch (t: Throwable) { Timber.w(t, "ADM release failed") }
        }
        adm = null
        Timber.d("WebRtcAudio capture released")
    }
}
