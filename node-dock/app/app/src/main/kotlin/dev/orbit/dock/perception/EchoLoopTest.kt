package dev.orbit.dock.perception

import android.content.Context
import android.media.AudioFormat
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.webrtc.AudioSource
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import timber.log.Timber
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/**
 * DEBUG hypothesis test: does routing TTS **through WebRTC** (so its software AEC
 * gets the playback as a proper reference) cancel the dock's own voice far better
 * than the phone's hardware AEC?
 *
 * Architecture (all on-device, no server):
 *   - fTts factory: a custom ADM whose AudioBufferCallback streams TTS PCM into
 *     the captured buffer → pcA *sends* TTS over a local loopback.
 *   - fAec factory: the dock-style ADM (VOICE_COMMUNICATION, software AEC, HW AEC
 *     off). pcB *receives* the TTS track and renders it through this ADM → out the
 *     speaker AND as the AEC reference. This ADM also captures the real mic; its
 *     SamplesReadyCallback gives us the AEC'd mic, which we write to a WAV.
 *
 * Then: pull echo-loop-residual.wav and listen. If the hypothesis holds, the
 * dock's voice should be far more cancelled than mic-residual.wav (hardware AEC).
 *
 *   adb shell am broadcast -a dev.orbit.dock.ECHO_LOOP
 *   adb pull /sdcard/Android/data/dev.orbit.dock/files/echo-loop-residual.wav
 */
object EchoLoopTest {
    private const val TAG = "ECHO_LOOP"
    private const val SR = 16_000

    @Volatile private var running = false

    fun run(context: Context) {
        if (running) return
        running = true
        val ctx = context.applicationContext
        Thread { try { go(ctx) } catch (t: Throwable) { Timber.tag(TAG).e(t, "failed"); running = false } }.start()
    }

    // Single-thread executor: marshal ALL PeerConnection calls here so we never
    // call pcA from pcB's native signaling thread (or vice-versa) — cross-factory
    // calls from the other peer's callback thread deadlock natively.
    private val exec = java.util.concurrent.Executors.newSingleThreadExecutor()
    private fun post(r: () -> Unit) { exec.execute { try { r() } catch (t: Throwable) { Timber.tag(TAG).e(t, "post threw") } } }

    private fun go(ctx: Context) {
        // 1) Synthesize the probe phrase to PCM first (so we can stream it).
        Timber.tag(TAG).i("synthesizing TTS to PCM…")
        val ttsPcm = synthesizeToPcm(ctx, PROBE) ?: run {
            Timber.tag(TAG).e("TTS synth failed"); running = false; return
        }
        Timber.tag(TAG).i("TTS PCM ready: ${ttsPcm.size} bytes (~${ttsPcm.size / 2 / SR}s)")

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions(),
        )

        // 2) Sender ADM: AudioBufferCallback streams TTS PCM into each mic buffer
        //    (replacing the real mic), so pcA sends TTS.
        var ttsPos = 0
        val senderAdm = JavaAudioDeviceModule.builder(ctx)
            .setSampleRate(SR)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioBufferCallback { buffer, _, _, _, bytesRead, captureTimeNs ->
                // Overwrite the captured buffer with the next slice of TTS PCM.
                buffer.clear()
                val n = bytesRead.coerceAtMost(buffer.capacity())
                var i = 0
                while (i < n) {
                    if (ttsPos >= ttsPcm.size) { buffer.put(0); } // silence past end
                    else buffer.put(ttsPcm[ttsPos++])
                    i++
                }
                buffer.position(0)
                captureTimeNs
            }
            .createAudioDeviceModule()
        val fTts = PeerConnectionFactory.builder().setAudioDeviceModule(senderAdm).createPeerConnectionFactory()

        // 3) AEC-side ADM: real mic + software AEC, renders pcB's received TTS as
        //    the reference. SamplesReadyCallback captures the AEC'd mic → WAV.
        val rec = ByteArrayOutputStream()
        val recording = java.util.concurrent.atomic.AtomicBoolean(false)
        val aecAdm = JavaAudioDeviceModule.builder(ctx)
            .setAudioSource(android.media.MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setSampleRate(SR)
            .setUseHardwareAcousticEchoCanceler(false)   // force WebRTC SOFTWARE AEC
            .setUseHardwareNoiseSuppressor(false)
            .setSamplesReadyCallback { s -> if (recording.get()) rec.write(s.data) }
            .createAudioDeviceModule()
        val fAec = PeerConnectionFactory.builder()
            .setAudioDeviceModule(aecAdm)
            .createPeerConnectionFactory()

        // 4) Loopback pcA(fTts) → pcB(fAec).
        val rtc = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val holder = object { var a: PeerConnection? = null; var b: PeerConnection? = null }
        val pcB = fAec.createPeerConnection(rtc, object : Obs("pcB") {
            override fun onIceCandidate(c: IceCandidate?) { c?.let { cand -> post { holder.a?.addIceCandidate(cand) } } }
            override fun onAddTrack(r: RtpReceiver?, s: Array<out org.webrtc.MediaStream>?) {
                (r?.track() as? org.webrtc.AudioTrack)?.setVolume(8.0)
                Timber.tag(TAG).i("pcB received TTS track → rendering through AEC ADM")
            }
        })!!
        val pcA = fTts.createPeerConnection(rtc, object : Obs("pcA") {
            override fun onIceCandidate(c: IceCandidate?) { c?.let { cand -> post { holder.b?.addIceCandidate(cand) } } }
        })!!
        holder.a = pcA; holder.b = pcB

        val track = fTts.createAudioTrack("tts", fTts.createAudioSource(MediaConstraints()))
        pcA.addTrack(track)

        // pcB must ALSO send a (mic) track so its AEC ADM actually starts capturing
        // the real mic — otherwise nothing is recorded and AEC has no capture to
        // process. This mic capture, with pcB's rendered TTS as the reference, is
        // exactly what we measure via the SamplesReadyCallback above.
        val micTrack = fAec.createAudioTrack("mic", fAec.createAudioSource(MediaConstraints()))
        pcB.addTrack(micTrack)

        pcA.createOffer(object : Sdp("offer") {
            override fun onCreateSuccess(o: SessionDescription?) {
                Timber.tag(TAG).i("offer created")
                o ?: return
                post { pcA.setLocalDescription(Sdp("aLocal"), o) }
                post { pcB.setRemoteDescription(object : Sdp("bRemote") {
                    override fun onSetSuccess() {
                        Timber.tag(TAG).i("bRemote set → creating answer")
                        post { pcB.createAnswer(object : Sdp("answer") {
                            override fun onCreateSuccess(ans: SessionDescription?) {
                                ans ?: return
                                Timber.tag(TAG).i("answer created; setting bLocal + aRemote")
                                post { pcB.setLocalDescription(Sdp("bLocal"), ans) }
                                post { pcA.setRemoteDescription(Sdp("aRemote"), ans) }
                                Timber.tag(TAG).i("both set calls issued")
                                // Do the record-and-wait on a SEPARATE thread — never
                                // block WebRTC's signaling callback thread (deadlocks).
                                Thread {
                                    Thread.sleep(1_500) // let render settle
                                    Timber.tag(TAG).i("recording AEC'd mic 8s; STAY SILENT to measure dock echo")
                                    recording.set(true)
                                    Thread.sleep(8_000)
                                    recording.set(false)
                                    val out = File(ctx.getExternalFilesDir(null), "echo-loop-residual.wav")
                                    writeWav(out, rec.toByteArray(), SR)
                                    Timber.tag(TAG).i("DONE — ${rec.size()} bytes → ${out.absolutePath}")
                                    Timber.tag(TAG).i("pull: adb pull ${out.absolutePath}")
                                    running = false
                                }.start()
                            }
                        }, MediaConstraints()) }   // close post{ createAnswer }
                    }
                }, o) }   // close post{ setRemoteDescription(bRemote) }
            }
        }, MediaConstraints())
    }

    private fun synthesizeToPcm(ctx: Context, text: String): ByteArray? {
        val done = Object()
        var result: ByteArray? = null
        var ready = false
        lateinit var tts: TextToSpeech
        tts = TextToSpeech(ctx) { status ->
            if (status != TextToSpeech.SUCCESS) { synchronized(done) { done.notify() }; return@TextToSpeech }
            ready = true; synchronized(done) { done.notify() }
        }
        synchronized(done) { if (!ready) done.wait(5_000) }
        if (!ready) return null
        val wav = File(ctx.cacheDir, "tts-probe.wav")
        val id = UUID.randomUUID().toString()
        val finished = Object()
        var ok = false
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(u: String?) {}
            override fun onDone(u: String?) { ok = true; synchronized(finished) { finished.notify() } }
            @Deprecated("") override fun onError(u: String?) { synchronized(finished) { finished.notify() } }
        })
        val params = Bundle()
        tts.synthesizeToFile(text, params, wav, id)
        synchronized(finished) { finished.wait(10_000) }
        tts.shutdown()
        if (!ok || !wav.exists()) return null
        // Strip the 44-byte WAV header → raw PCM-16. (synthesizeToFile writes a
        // RIFF WAV; we assume 16-bit. Resampling not handled — most engines emit
        // a rate near our SR; good enough for the residual test.)
        val all = wav.readBytes()
        return if (all.size > 44) all.copyOfRange(44, all.size) else null
    }

    private fun writeWav(file: File, pcm: ByteArray, sr: Int) {
        val raf = RandomAccessFile(file, "rw"); raf.setLength(0)
        fun w(s: String) = raf.write(s.toByteArray(Charsets.US_ASCII))
        fun i32(v: Int) = raf.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array())
        fun i16(v: Int) = raf.write(ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(v.toShort()).array())
        w("RIFF"); i32(36 + pcm.size); w("WAVE"); w("fmt "); i32(16); i16(1); i16(1)
        i32(sr); i32(sr * 2); i16(2); i16(16); w("data"); i32(pcm.size); raf.write(pcm); raf.close()
    }

    private open class Obs(val n: String) : PeerConnection.Observer {
        override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) { Timber.tag(TAG).i("$n ice=$s") }
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
    private open class Sdp(val w: String) : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) { Timber.tag(TAG).i("$w createOK") }
        override fun onSetSuccess() { Timber.tag(TAG).i("$w setOK") }
        override fun onCreateFailure(e: String?) { Timber.tag(TAG).e("$w createFail $e") }
        override fun onSetFailure(e: String?) { Timber.tag(TAG).e("$w setFail $e") }
    }

    private const val PROBE =
        "The quick brown fox jumps over the lazy dog while the river flows " +
        "gently past the old stone bridge under a bright morning sky."
}
