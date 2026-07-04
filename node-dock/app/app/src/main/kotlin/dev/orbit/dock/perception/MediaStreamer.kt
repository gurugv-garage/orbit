package dev.orbit.dock.perception

import android.content.Context
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.launch
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoSource
import timber.log.Timber

/**
 * Streams the dock's live A/V (AEC'd mic + camera) to orbit-station's WebRTC SFU.
 *
 * Builds a sendonly [PeerConnection] on [WebRtcAudio]'s shared factory (so the
 * audio track carries the echo-cancelled `VOICE_COMMUNICATION` mic), adds a video
 * track fed by [FaceTracker] frames via [FaceFrameCapturer], and runs the
 * producer-side offer/ICE handshake over the station `media` topic:
 *
 *   out:  producer-offer {streamId, sdp}   producer-ice {candidate}
 *   in:   producer-answer {streamId, sdp}   producer-ice {candidate}
 *
 * Media flows over the PeerConnection's SRTP transport straight to the SFU; only
 * signaling rides the station WS. The SFU fans the stream out to browser viewers.
 *
 * Lifecycle: [start] once the station is connected and [FaceTracker] is running;
 * [stop] tears the PeerConnection down (the shared factory/ADM are left alone —
 * they're owned by [WebRtcAudio] and shared with the perception pipeline).
 *
 * @param label    human display name (the dock name); the SFU derives the unique
 *                 streamId from this app's peer id, so two phones flashed with the
 *                 same dock name never collide.
 * @param publish  sends a `media` frame to the station (StationLink.publish).
 */
class MediaStreamer(
    private val context: Context,
    private val faceTracker: FaceTracker,
    private val label: String,
    private val publish: (kind: String, payload: JsonObject) -> Unit,
) {
    private var pc: PeerConnection? = null
    private var videoSource: VideoSource? = null
    private var audioSource: org.webrtc.AudioSource? = null
    private var audioTrack: org.webrtc.AudioTrack? = null
    private var videoTrack: org.webrtc.VideoTrack? = null
    private var capturer: FaceFrameCapturer? = null
    @Volatile private var started = false
    // Mic mute = the SINGLE real switch. When true, the WebRTC audio track is
    // DISABLED so the station receives silence (no STT, no listening). Held here so
    // it survives a track re-create (stream restart / reconnect) — applied in start().
    @Volatile private var muted = false

    // Recovery: ICE can DISCONNECT/FAIL (network blip, SFU restart). The dead
    // PeerConnection never heals itself, leaving the station with no video
    // (producers:[]) until the app restarts — the cause of "I don't see anyone".
    // We restart the stream when that happens.
    private val scope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main,
    )
    private var recoverJob: kotlinx.coroutines.Job? = null

    /** True once the PeerConnection + tracks are up. */
    fun isStreaming(): Boolean = started

    /** Mic mute — the REAL switch. Disables/enables the WebRTC audio track so the
     *  station receives silence (no STT, no listening) when muted. Idempotent;
     *  remembered so a later stream (re)start re-applies it (see start()). */
    fun setMuted(muted: Boolean) {
        this.muted = muted
        audioTrack?.setEnabled(!muted)
    }

    /** Tear down + rebuild the PeerConnection, then re-offer. Used both internally
     *  (ICE failure) and externally (the STATION reconnected, so the SFU restarted
     *  and dropped our producer — our old offer is dead and must be re-sent, even
     *  though `started` is still true from the previous session). */
    @Synchronized
    fun restart() {
        Timber.i("MediaStreamer: restart() — tearing down + re-offering")
        stop()
        start()
    }

    /** React to ICE state: recover on FAILED now, on sustained DISCONNECTED. */
    private fun onIceState(s: PeerConnection.IceConnectionState?) {
        Timber.i("MediaStreamer ice=$s")
        when (s) {
            PeerConnection.IceConnectionState.CONNECTED,
            PeerConnection.IceConnectionState.COMPLETED -> {
                recoverJob?.cancel(); recoverJob = null // healed — cancel any pending restart
            }
            PeerConnection.IceConnectionState.FAILED -> {
                recoverJob?.cancel()
                recoverJob = scope.launch { restart() } // unrecoverable → rebuild now
            }
            PeerConnection.IceConnectionState.DISCONNECTED -> {
                // may self-heal; wait a few seconds, then restart if still not back.
                recoverJob?.cancel()
                recoverJob = scope.launch {
                    kotlinx.coroutines.delay(4000)
                    restart()
                }
            }
            else -> {}
        }
    }

    @Synchronized
    fun start() {
        if (started) return
        Timber.i("MediaStreamer.start() — building factory + tracks")
        val factory = WebRtcAudio.sharedFactory(context) ?: run {
            Timber.w("MediaStreamer: no shared factory (mic not capturing yet) — will retry")
            return
        }
        started = true

        val rtc = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val connection = factory.createPeerConnection(rtc, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate?) {
                c ?: return
                publish("producer-ice", buildJsonObject {
                    put("candidate", iceToJson(c))
                })
            }
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {
                onIceState(s)
            }
            override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: org.webrtc.MediaStream?) {}
            override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
            override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver?, s: Array<out org.webrtc.MediaStream>?) {}
        }) ?: run {
            Timber.e("MediaStreamer: createPeerConnection returned null")
            started = false
            return
        }
        pc = connection

        // Audio: AEC'd mic, published over WebRTC to the station's always-on STT
        // (A1, the always-on-mic shift — docs/perception-to-brain.md). This is now
        // safe because the on-device Android SpeechRecognizer is GONE: the mic is
        // no longer time-shared, so the shared ADM captures continuously and the
        // audio source draws from that one capture (Option B′ — one ADM feeds both
        // the local perception pipeline and this track; NO second
        // VOICE_COMMUNICATION session). The track carries the hardware-AEC'd
        // VOICE_COMMUNICATION mic, so the station won't transcribe the dock's own
        // TTS. createAudioSource() with no extra constraints — the ADM already
        // applies HW AEC/NS; we don't want WebRTC's software NS gating room audio.
        val audioSource = factory.createAudioSource(MediaConstraints())
        this.audioSource = audioSource
        val audioTrack = factory.createAudioTrack("dock-audio", audioSource)
        this.audioTrack = audioTrack
        connection.addTrack(audioTrack)
        // Re-assert the current mute on a freshly-created track (reconnect/restart):
        // a track is enabled by default, so without this a muted dock would start
        // hearing again after a stream restart.
        audioTrack.setEnabled(!muted)

        // Video: FaceTracker frames pushed into a VideoSource (~1 Hz slideshow).
        val vSource = factory.createVideoSource(false)
        videoSource = vSource
        val cap = FaceFrameCapturer(vSource).also { it.start() }
        capturer = cap
        faceTracker.onBitmapFrame = { bmp -> cap.onFrame(bmp) }
        val videoTrack = factory.createVideoTrack("dock-video", vSource)
        this.videoTrack = videoTrack
        val videoSender = connection.addTrack(videoTrack)

        // Per-frame bitrate fix for a SLOW (~2-5 Hz) video track. libwebrtc's VP8
        // rate controller budgets bits PER SECOND assuming ~30 fps, so at a few
        // fps it starves each keyframe's quantizer → blocky, soft frames. The
        // brain's vision grab, the /frame route, and the console Live Wall all
        // read those frames, so this is the real sharpness lever (ffmpeg -q:v on
        // the station is only the second, smaller pass). Fix = tell the encoder
        // the true framerate (so it stops amortizing across phantom 30 fps) AND
        // give it a high per-second ceiling so each of the few frames can be big.
        //
        // ⚠️ CLOUD MOVE: this is tuned for LAN (bitrate is ~free on local Wi-Fi).
        // A continuous ~2.5 Mbps uplink to a cloud VM is metered + gated by home
        // broadband upload. Before/at the cloud cutover, switch to a burst/on-
        // demand or gate-on-change policy — see docs/remote-deployment.md
        // ("Media bandwidth to cloud").
        runCatching {
            val params = videoSender?.parameters
            params?.encodings?.firstOrNull()?.let { enc ->
                enc.maxFramerate = 5          // match the real push rate (FaceTracker ~2-5 Hz)
                enc.maxBitrateBps = 2_500_000 // per-second ceiling; at ~5 fps this is a rich per-frame budget
                enc.minBitrateBps = 800_000   // keep the controller from collapsing quality on a quiet scene
            }
            if (params != null) videoSender.parameters = params
        }.onFailure { Timber.w(it, "MediaStreamer: could not set video encoding params") }

        // Resume the ADM capture now that the new audio source/PC sink exists (it
        // was paused in stop() to avoid the teardown race). Idempotent on a fresh
        // ADM that's already recording.
        WebRtcAudio.resumeRecording()

        // Offer → publish producer-offer.
        connection.createOffer(object : SdpAdapter("createOffer") {
            override fun onCreateSuccess(offer: SessionDescription?) {
                offer ?: return
                connection.setLocalDescription(SdpAdapter("setLocal"), offer)
                publish("producer-offer", buildJsonObject {
                    put("label", label)
                    put("sdp", offer.description)
                })
                Timber.i("MediaStreamer: producer-offer sent (label=$label)")
            }
        }, MediaConstraints())
    }

    /** Handle an inbound `media` frame from the SFU (producer-answer / producer-ice). */
    fun onMediaFrame(kind: String, payload: JsonObject) {
        val connection = pc ?: return
        when (kind) {
            "producer-answer" -> {
                val sdp = payload["sdp"]?.jsonPrimitive?.content ?: return
                connection.setRemoteDescription(
                    SdpAdapter("setRemote"),
                    SessionDescription(SessionDescription.Type.ANSWER, sdp),
                )
            }
            "producer-ice" -> {
                val cand = payload["candidate"]?.jsonObject ?: return
                jsonToIce(cand)?.let { connection.addIceCandidate(it) }
            }
        }
    }

    @Synchronized
    fun stop() {
        if (!started) return
        started = false
        faceTracker.onBitmapFrame = null
        capturer?.stop(); capturer = null
        // CRITICAL ordering (fixes the AudioRecordThread SIGSEGV): the shared ADM's
        // capture thread is always-on; if we dispose the audioSource/PeerConnection
        // (the native sink nativeDataIsRecorded writes into) while it's still
        // recording, the next in-flight buffer memcpys into freed memory → crash.
        // Pause the ADM's capture FIRST, so no buffer is in flight during disposal,
        // then dispose. start()/restart() resumes it after the rebuild.
        WebRtcAudio.pauseRecording()
        // dispose(), not close(): close() stops the connection but leaves the
        // native PeerConnection object allocated; dispose() frees it. Across
        // repeated restart()s (ICE flaps), close()-only leaked native PC +
        // RtpSender objects — the slow native-heap creep over long uptimes.
        //
        // DISPOSAL ORDER (webrtc-sdk 125): PeerConnection FIRST — it owns its
        // senders/transceivers and frees them internally; disposing a track that
        // a live sender still references is the crash-prone path. Then the tracks,
        // then the sources the tracks wrap. The ADM is already paused (above), so
        // no capture buffer is in flight into the freed native sink.
        try { pc?.dispose() } catch (_: Throwable) {}
        pc = null
        try { audioTrack?.dispose() } catch (_: Throwable) {}
        audioTrack = null
        try { videoTrack?.dispose() } catch (_: Throwable) {}
        videoTrack = null
        try { videoSource?.dispose() } catch (_: Throwable) {}
        videoSource = null
        try { audioSource?.dispose() } catch (_: Throwable) {}
        audioSource = null
        Timber.d("MediaStreamer stopped (capture paused)")
    }

    // ── ICE JSON <-> webrtc IceCandidate ────────────────────────────────────────
    // Wire shape matches werift/browser RTCIceCandidateInit:
    //   { candidate: <sdp string>, sdpMid, sdpMLineIndex }
    private fun iceToJson(c: IceCandidate): JsonObject = buildJsonObject {
        put("candidate", c.sdp)
        put("sdpMid", c.sdpMid)
        put("sdpMLineIndex", c.sdpMLineIndex)
    }

    private fun jsonToIce(o: JsonObject): IceCandidate? {
        val sdp = o["candidate"]?.jsonPrimitive?.content ?: return null
        val mid = o["sdpMid"]?.jsonPrimitive?.content ?: ""
        val mline = (o["sdpMLineIndex"]?.jsonPrimitive)?.let {
            runCatching { it.int }.getOrNull()
        } ?: 0
        return IceCandidate(mid, mline, sdp)
    }
}

/** No-op-by-default [SdpObserver] that logs failures under one tag. */
private open class SdpAdapter(private val what: String) : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(e: String?) { Timber.w("MediaStreamer $what createFail: $e") }
    override fun onSetFailure(e: String?) { Timber.w("MediaStreamer $what setFail: $e") }
}
