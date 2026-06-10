package dev.orbit.dock.perception

import android.content.Context
import org.webrtc.AudioSource
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import timber.log.Timber

/**
 * DEBUG capability probe: stand up a local **loopback** of two PeerConnections
 * wired to each other in-process (no network, no signaling server) — pcA sends an
 * audio track, pcB receives it. Goal: prove we can route audio peer→peer entirely
 * on-device, as the foundation for playing TTS *through* WebRTC so its AEC has the
 * reference signal.
 *
 * This only proves the loopback flows + what shows up on the receive side. It logs
 * under LOOPBACK. Trigger: adb shell am broadcast -a dev.orbit.dock.LOOPBACK_PROBE
 */
object LoopbackProbe {

    private var pcA: PeerConnection? = null
    private var pcB: PeerConnection? = null
    private var factory: PeerConnectionFactory? = null

    fun run(context: Context) {
        val tag = "LOOPBACK"
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions
                    .builder(context.applicationContext)
                    .createInitializationOptions(),
            )
            val egl = EglBase.create()
            val f = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
            factory = f
            Timber.tag(tag).i("factory created")

            val rtc = PeerConnection.RTCConfiguration(emptyList()).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }

            // Forward-ref holders so each peer's ICE candidates reach the other.
            val holder = object { var a: PeerConnection? = null; var b: PeerConnection? = null }

            val b = f.createPeerConnection(rtc, object : PcObserver("pcB") {
                override fun onIceCandidate(c: IceCandidate?) { c?.let { holder.a?.addIceCandidate(it) } }
                override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {
                    val t: MediaStreamTrack? = receiver?.track()
                    Timber.tag(tag).i("pcB RECEIVED track kind=${t?.kind()} id=${t?.id()}")
                    // Force playout volume up so we can hear if the received track
                    // actually renders through the ADM → out the speaker.
                    (t as? org.webrtc.AudioTrack)?.let {
                        it.setVolume(10.0)
                        Timber.tag(tag).i("pcB set received audio track volume=10 → LISTEN: do you hear the mic looped back out the speaker?")
                    }
                }
            })!!
            val a = f.createPeerConnection(rtc, object : PcObserver("pcA") {
                override fun onIceCandidate(c: IceCandidate?) { c?.let { holder.b?.addIceCandidate(it) } }
            })!!
            holder.a = a; holder.b = b
            pcA = a; pcB = b

            // pcA sends an audio track (mic-backed source — the only kind the lib makes).
            val src: AudioSource = f.createAudioSource(MediaConstraints())
            val track = f.createAudioTrack("loop-audio", src)
            a.addTrack(track)
            Timber.tag(tag).i("pcA added audio track; creating offer…")

            // Minimal SDP handshake A→B→A, all in-process.
            a.createOffer(object : SimpleSdp("A.createOffer") {
                override fun onCreateSuccess(offer: SessionDescription?) {
                    offer ?: return
                    a.setLocalDescription(SimpleSdp("A.setLocal"), offer)
                    b.setRemoteDescription(object : SimpleSdp("B.setRemote") {
                        override fun onSetSuccess() {
                            b.createAnswer(object : SimpleSdp("B.createAnswer") {
                                override fun onCreateSuccess(answer: SessionDescription?) {
                                    answer ?: return
                                    b.setLocalDescription(SimpleSdp("B.setLocal"), answer)
                                    a.setRemoteDescription(SimpleSdp("A.setRemote"), answer)
                                    Timber.tag(tag).i("handshake complete — watch for 'pcB RECEIVED track'")
                                }
                            }, MediaConstraints())
                        }
                    }, offer)
                }
            }, MediaConstraints())
        } catch (t: Throwable) {
            Timber.tag(tag).e(t, "loopback probe failed")
        }
    }

    private open class PcObserver(val name: String) : PeerConnection.Observer {
        override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {
            Timber.tag("LOOPBACK").i("$name ice=$s")
        }
        override fun onIceConnectionReceivingChange(p0: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(c: IceCandidate?) {}
        override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
        override fun onAddStream(p0: org.webrtc.MediaStream?) {}
        override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
        override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(p0: RtpReceiver?, p1: Array<out org.webrtc.MediaStream>?) {}
    }

    private open class SimpleSdp(val what: String) : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(e: String?) { Timber.tag("LOOPBACK").e("$what createFail: $e") }
        override fun onSetFailure(e: String?) { Timber.tag("LOOPBACK").e("$what setFail: $e") }
    }
}
