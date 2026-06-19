package dev.orbit.dock.perception

import android.content.Context
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import timber.log.Timber
import java.util.concurrent.ConcurrentLinkedQueue

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

    /** Shared EGL context for video encode/decode + the capturer's surface. */
    private var egl: EglBase? = null
    /** The one factory streaming attaches to (ADM + video). Built lazily. */
    private var factory: PeerConnectionFactory? = null

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

        // A1 AEC (docs/perception-to-brain.md): use WebRTC's SOFTWARE AEC, not the
        // hardware one. Proven (AecPocTest, residual 0.0002 vs HW-AEC leak): the
        // software AEC cancels the dock's own TTS from the STREAMED mic — but ONLY
        // when the TTS is rendered through THIS module's playout (the loopback fed by
        // DockTts, see [renderTtsPcm]). HW AEC referenced only the device's vague
        // "speaker mix" and left the dock's voice in the WebRTC stream (the station
        // transcribed itself). Software AEC + WebRTC-rendered TTS reference fixes it.
        Timber.i("WebRtcAudio: source=VOICE_COMMUNICATION SOFTWARE-AEC (HW AEC off)")

        val module = JavaAudioDeviceModule.builder(context.applicationContext)
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setSampleRate(SAMPLE_RATE)
            .setUseHardwareAcousticEchoCanceler(false) // ← WebRTC software AEC (see above)
            .setUseHardwareNoiseSuppressor(false)
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
     *
     * NOTE (streaming, plan Option B): this release is what makes the live
     * stream's audio glitch during STT — the [factory]'s audio source draws from
     * this ADM. We accept the glitch for now (video keeps flowing); the next
     * [startCapture] rebuilds the ADM and the existing audio track resumes. The
     * shared [factory]/[egl] are deliberately NOT torn down here, so the
     * PeerConnection + tracks survive an ADM rebuild.
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

    /** The shared EGL base (for video encoder + the capturer's SurfaceTextureHelper). */
    @Synchronized
    fun eglBase(context: Context): EglBase {
        ensureNativeInit(context)
        return egl ?: EglBase.create().also { egl = it }
    }

    /**
     * The single [PeerConnectionFactory] the live stream attaches to — built once
     * with **this** module's AEC'd [JavaAudioDeviceModule] as its ADM (so an audio
     * track carries the echo-cancelled mic) plus HW video encode/decode. Requires
     * [startCapture] to have run so the ADM exists. Lazily built and reused.
     *
     * Owning the factory here (not in the streamer) keeps the "one factory/ADM,
     * owned once" invariant: the factory outlives ADM rebuilds across STT turns.
     */
    @Synchronized
    fun sharedFactory(context: Context): PeerConnectionFactory? {
        factory?.let { return it }
        val module = adm ?: run {
            Timber.w("sharedFactory before startCapture — no ADM; call startCapture first")
            return null
        }
        ensureNativeInit(context)
        val e = eglBase(context)
        return PeerConnectionFactory.builder()
            .setAudioDeviceModule(module)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(e.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(e.eglBaseContext))
            .createPeerConnectionFactory()
            .also { factory = it; Timber.d("WebRtcAudio shared factory created") }
    }

    // ── TTS-as-AEC-reference loopback (A1) ──────────────────────────────────────
    // To let the software AEC cancel the dock's own TTS from the streamed mic, the
    // TTS must be RENDERED through the production ADM's playout (the AEC reference).
    // There's no API to push PCM straight into playout, so we loop it back as a
    // WebRTC track: a sender PC (its own injecting ADM) → a receiver PC on the
    // SHARED factory; the received track is rendered through the production ADM,
    // which both plays it out the speaker AND uses it as the AEC reference.
    // Proven by AecPocTest (residual 0.0002). DockTts calls [renderTtsPcm].

    // TTS PCM awaiting render, as whole byte CHUNKS (not boxed per-byte — that
    // allocated + GC-churned inside the real-time audio callback and made the voice
    // grainy). The ADM pull callback drains chunks in bulk, sample-aligned.
    private val ttsChunks = ConcurrentLinkedQueue<ByteArray>()
    private var ttsHead: ByteArray? = null   // current chunk being drained
    private var ttsHeadPos = 0               // offset into ttsHead
    private val ttsLock = Any()
    private var loopback: TtsAecLoopback? = null

    /** Feed a chunk of TTS PCM-16 mono @16 kHz to be rendered through WebRTC (so it
     *  becomes the AEC reference + plays out the speaker). Lazily stands up the
     *  loopback on first use. Safe to call repeatedly; chunks are queued + drained. */
    @Synchronized
    fun renderTtsPcm(context: Context, pcm16: ByteArray) {
        val f = sharedFactory(context) ?: run {
            Timber.w("renderTtsPcm before sharedFactory — dropping ${pcm16.size}B"); return
        }
        if (pcm16.isNotEmpty()) ttsChunks.add(pcm16)
        if (loopback == null) {
            loopback = TtsAecLoopback(context, f) { dst, want -> drainTts(dst, want) }
                .also { it.start() }
        }
    }

    /** Fill `dst` with up to `want` bytes from the chunk queue; zero-pad on underrun.
     *  Bulk array copies, no per-byte boxing — smooth for the audio callback. */
    private fun drainTts(dst: java.nio.ByteBuffer, want: Int) {
        synchronized(ttsLock) {
            var filled = 0
            while (filled < want) {
                var head = ttsHead
                if (head == null || ttsHeadPos >= head.size) {
                    head = ttsChunks.poll()
                    ttsHead = head; ttsHeadPos = 0
                    if (head == null) break // underrun → pad the rest with silence
                }
                val n = minOf(want - filled, head.size - ttsHeadPos)
                dst.put(head, ttsHeadPos, n)
                ttsHeadPos += n; filled += n
            }
            while (filled < want) { dst.put(0); filled++ }
        }
    }

    /** Drop any TTS PCM not yet rendered (barge-in / stop). Playback goes silent
     *  within one ADM buffer; the loopback PCs stay up for the next utterance. */
    fun stopTtsRender() {
        synchronized(ttsLock) { ttsChunks.clear(); ttsHead = null; ttsHeadPos = 0 }
    }
}

/**
 * A local WebRTC loopback that renders injected PCM through a target factory's ADM
 * (the production capture ADM) so it becomes the software-AEC reference. The sender
 * side runs on its own factory with an ADM whose capture buffer is filled from
 * [pull]; the receiver runs on [renderFactory] (the shared production factory) so
 * its received track is played out through the production ADM. See AecPocTest.
 */
private class TtsAecLoopback(
    context: Context,
    private val renderFactory: PeerConnectionFactory,
    /** fill `dst` with up to `want` bytes of PCM (zero-pad past end). */
    private val pull: (dst: java.nio.ByteBuffer, want: Int) -> Unit,
) {
    private val ctx = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var senderFactory: PeerConnectionFactory? = null
    private var pcSend: PeerConnection? = null
    private var pcRecv: PeerConnection? = null

    fun start() {
        val senderAdm = JavaAudioDeviceModule.builder(ctx)
            .setSampleRate(WebRtcAudio.SAMPLE_RATE)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioBufferCallback { buffer, _, _, _, bytesRead, captureTimeNs ->
                buffer.clear()
                pull(buffer, bytesRead.coerceAtMost(buffer.capacity()))
                buffer.position(0); captureTimeNs
            }
            .createAudioDeviceModule()
        val fSend = PeerConnectionFactory.builder().setAudioDeviceModule(senderAdm).createPeerConnectionFactory()
        senderFactory = fSend

        val rtc = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val holder = object { var s: PeerConnection? = null; var r: PeerConnection? = null }
        val recv = renderFactory.createPeerConnection(rtc, object : LoopObs("ttsRecv") {
            override fun onIceCandidate(c: IceCandidate?) { c?.let { x -> main.post { holder.s?.addIceCandidate(x) } } }
            override fun onAddTrack(r: RtpReceiver?, s: Array<out org.webrtc.MediaStream>?) {
                // Moderate gain: high enough to be audible + a clean AEC reference,
                // low enough not to overdrive/clip (10.0 was rough). Tune if quiet.
                (r?.track() as? org.webrtc.AudioTrack)?.setVolume(2.0)
                Timber.i("TtsAecLoopback: recv TTS track → rendering through production ADM")
            }
        }) ?: return
        val send = fSend.createPeerConnection(rtc, object : LoopObs("ttsSend") {
            override fun onIceCandidate(c: IceCandidate?) { c?.let { x -> main.post { holder.r?.addIceCandidate(x) } } }
        }) ?: return
        pcRecv = recv; pcSend = send; holder.s = send; holder.r = recv

        send.addTrack(fSend.createAudioTrack("tts-aec", fSend.createAudioSource(MediaConstraints())))

        send.createOffer(object : LoopSdp("offer") {
            override fun onCreateSuccess(o: SessionDescription?) {
                o ?: return
                main.post { send.setLocalDescription(LoopSdp("sLocal"), o) }
                main.post { recv.setRemoteDescription(object : LoopSdp("rRemote") {
                    override fun onSetSuccess() {
                        main.post { recv.createAnswer(object : LoopSdp("answer") {
                            override fun onCreateSuccess(a: SessionDescription?) {
                                a ?: return
                                main.post { recv.setLocalDescription(LoopSdp("rLocal"), a) }
                                main.post { send.setRemoteDescription(LoopSdp("sRemote"), a) }
                            }
                        }, MediaConstraints()) }
                    }
                }, o) }
            }
        }, MediaConstraints())
    }

    private open class LoopObs(val n: String) : PeerConnection.Observer {
        override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) { Timber.d("TtsAecLoopback $n ice=$s") }
        override fun onIceConnectionReceivingChange(p0: Boolean) {}
        override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(p0: IceCandidate?) {}
        override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
        override fun onAddStream(p0: org.webrtc.MediaStream?) {}
        override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
        override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(p0: RtpReceiver?, p1: Array<out org.webrtc.MediaStream>?) {}
    }
    private open class LoopSdp(val w: String) : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(e: String?) { Timber.w("TtsAecLoopback $w createFail $e") }
        override fun onSetFailure(e: String?) { Timber.w("TtsAecLoopback $w setFail $e") }
    }
}
