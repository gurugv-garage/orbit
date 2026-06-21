package dev.orbit.dock.perception

import android.content.Context
import android.media.MediaRecorder
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
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
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A1 POC — does the PRODUCTION-STYLE single capture ADM (real mic via
 * VOICE_COMMUNICATION) cancel the dock's own TTS when the TTS is RENDERED through
 * WebRTC (received as a loopback track) and WebRTC SOFTWARE AEC is on?
 *
 * This differs from EchoLoopTest in the one way that matters for porting to
 * production: the receiver ADM here is built EXACTLY like WebRtcAudio's
 * (VOICE_COMMUNICATION mic, mono 16 kHz), except HW-AEC is FORCED OFF so WebRTC's
 * software AEC engages (production currently uses HW AEC — suspected insufficient).
 *
 * It measures the **samplesReadyCallback** mic — i.e. the exact PCM that, in
 * production, gets packetized to the station. If that goes silent while the dock's
 * TTS plays through the render path, A1 works and the port is: (1) flip the prod
 * ADM to software AEC, (2) feed DockTts PCM in as a loopback track.
 *
 *   adb shell am broadcast -a dev.orbit.dock.debug.AECPOC
 *   adb pull /sdcard/Android/data/dev.orbit.dock/files/aec-poc-residual.wav
 */
object AecPocTest {
    private const val TAG = "AEC_POC"
    private const val SR = 16_000
    @Volatile private var running = false

    fun run(context: Context) {
        if (running) { Timber.tag(TAG).w("already running"); return }
        running = true
        val ctx = context.applicationContext
        Thread { try { go(ctx) } catch (t: Throwable) { Timber.tag(TAG).e(t, "failed"); running = false } }.start()
    }

    /**
     * PRODUCTION loopback test: synthesize the probe and feed it to the REAL
     * [WebRtcAudio.renderTtsPcm] (the production shared-factory loopback) while the
     * app is live-streaming to the station. If A1 works, the dock is audible AND the
     * station does NOT transcribe this probe. Drive: adb ... debug.AECPROD.
     */
    fun pumpThroughProduction(context: Context) {
        val ctx = context.applicationContext
        Thread {
            Timber.tag(TAG).i("PROD: synth probe…")
            val pcm = synthesizeToPcm(ctx) ?: run { Timber.tag(TAG).e("PROD synth failed"); return@Thread }
            Timber.tag(TAG).i("PROD: feeding ${pcm.size}B to WebRtcAudio.renderTtsPcm (real loopback)")
            // Feed in ~20ms chunks so the injecting ADM drains smoothly at 16kHz.
            val chunk = WebRtcAudio.SAMPLE_RATE / 50 * 2 // 20ms of 16-bit mono
            var off = 0
            while (off < pcm.size) {
                val end = (off + chunk).coerceAtMost(pcm.size)
                WebRtcAudio.renderTtsPcm(ctx, pcm.copyOfRange(off, end))
                off = end
                Thread.sleep(20)
            }
            Timber.tag(TAG).i("PROD: done feeding probe")
        }.start()
    }

    private fun go(ctx: Context) {
        Timber.tag(TAG).i("synth TTS…")
        val ttsPcm = synthesizeToPcm(ctx) ?: run { Timber.tag(TAG).e("TTS synth failed"); running = false; return }
        Timber.tag(TAG).i("TTS PCM ${ttsPcm.size} bytes (~${ttsPcm.size / 2 / SR}s)")

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions(),
        )

        // SENDER: an ADM that injects the TTS PCM as its "mic" (so pcSend sends TTS).
        var pos = 0
        val senderAdm = JavaAudioDeviceModule.builder(ctx)
            .setSampleRate(SR)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioBufferCallback { buffer, _, _, _, bytesRead, captureTimeNs ->
                buffer.clear()
                val n = bytesRead.coerceAtMost(buffer.capacity())
                var i = 0
                while (i < n) { buffer.put(if (pos < ttsPcm.size) ttsPcm[pos++] else 0); i++ }
                buffer.position(0); captureTimeNs
            }
            .createAudioDeviceModule()
        val fSend = PeerConnectionFactory.builder().setAudioDeviceModule(senderAdm).createPeerConnectionFactory()

        // RECEIVER: built like WebRtcAudio's PRODUCTION ADM, but SOFTWARE AEC (HW off).
        val rec = ByteArrayOutputStream()
        val recording = AtomicBoolean(false)
        val recvAdm = JavaAudioDeviceModule.builder(ctx)
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setSampleRate(SR)
            .setUseHardwareAcousticEchoCanceler(false) // ← force WebRTC SOFTWARE AEC
            .setUseHardwareNoiseSuppressor(false)
            .setSamplesReadyCallback { s -> if (recording.get()) rec.write(s.data) }
            .createAudioDeviceModule()
        val fRecv = PeerConnectionFactory.builder().setAudioDeviceModule(recvAdm).createPeerConnectionFactory()

        val rtc = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val h = object { var send: PeerConnection? = null; var recv: PeerConnection? = null }
        val pcRecv = fRecv.createPeerConnection(rtc, object : Obs("recv") {
            override fun onIceCandidate(c: IceCandidate?) { c?.let { x -> post { h.send?.addIceCandidate(x) } } }
            override fun onAddTrack(r: RtpReceiver?, s: Array<out org.webrtc.MediaStream>?) {
                (r?.track() as? org.webrtc.AudioTrack)?.setVolume(8.0)
                Timber.tag(TAG).i("recv got TTS track → rendering through prod-style ADM")
            }
        })!!
        val pcSend = fSend.createPeerConnection(rtc, object : Obs("send") {
            override fun onIceCandidate(c: IceCandidate?) { c?.let { x -> post { h.recv?.addIceCandidate(x) } } }
        })!!
        h.send = pcSend; h.recv = pcRecv

        pcSend.addTrack(fSend.createAudioTrack("tts", fSend.createAudioSource(MediaConstraints())))
        // recv must send a (mic) track so its ADM actually captures the real mic.
        pcRecv.addTrack(fRecv.createAudioTrack("mic", fRecv.createAudioSource(MediaConstraints())))

        pcSend.createOffer(object : Sdp("offer") {
            override fun onCreateSuccess(o: SessionDescription?) {
                o ?: return
                post { pcSend.setLocalDescription(Sdp("sLocal"), o) }
                post { pcRecv.setRemoteDescription(object : Sdp("rRemote") {
                    override fun onSetSuccess() {
                        post { pcRecv.createAnswer(object : Sdp("answer") {
                            override fun onCreateSuccess(a: SessionDescription?) {
                                a ?: return
                                post { pcRecv.setLocalDescription(Sdp("rLocal"), a) }
                                post { pcSend.setRemoteDescription(Sdp("sRemote"), a) }
                                Thread {
                                    Thread.sleep(1_500)
                                    Timber.tag(TAG).i("recording AEC'd mic 8s; STAY SILENT")
                                    recording.set(true); Thread.sleep(8_000); recording.set(false)
                                    val out = File(ctx.getExternalFilesDir(null), "aec-poc-residual.wav")
                                    writeWav(out, rec.toByteArray(), SR)
                                    Timber.tag(TAG).i("DONE — ${rec.size()} bytes → ${out.absolutePath}")
                                    running = false
                                }.start()
                            }
                        }, MediaConstraints()) }
                    }
                }, o) }
            }
        }, MediaConstraints())
    }

    private fun synthesizeToPcm(ctx: Context): ByteArray? {
        val done = Object(); var ready = false
        lateinit var tts: TextToSpeech
        tts = TextToSpeech(ctx) { s -> if (s == TextToSpeech.SUCCESS) ready = true; synchronized(done) { done.notify() } }
        synchronized(done) { if (!ready) done.wait(5_000) }
        if (!ready) return null
        val wav = File(ctx.cacheDir, "aec-poc-tts.wav"); val id = UUID.randomUUID().toString()
        val fin = Object(); var ok = false
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(u: String?) {}
            override fun onDone(u: String?) { ok = true; synchronized(fin) { fin.notify() } }
            @Deprecated("") override fun onError(u: String?) { synchronized(fin) { fin.notify() } }
        })
        tts.synthesizeToFile(PROBE, Bundle(), wav, id)
        synchronized(fin) { fin.wait(10_000) }
        tts.shutdown()
        if (!ok || !wav.exists()) return null
        val all = wav.readBytes()
        if (all.size <= 44) return null
        // The TTS engine emits its OWN rate (measured: 24000 Hz), NOT 16k. Feeding
        // 24k PCM as 16k slows + pitches it down (the distortion). Read the real
        // rate from the WAV header and resample to SR (16k) before the loopback.
        val srcRate = ByteBuffer.wrap(all, 24, 4).order(ByteOrder.LITTLE_ENDIAN).int
        val pcm = all.copyOfRange(44, all.size)
        return if (srcRate == SR) pcm else resamplePcm16(pcm, srcRate, SR)
    }

    /** Linear-interpolation resample of mono PCM-16 LE from srcRate → dstRate. */
    private fun resamplePcm16(src: ByteArray, srcRate: Int, dstRate: Int): ByteArray {
        val inN = src.size / 2
        val sb = ByteBuffer.wrap(src).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val outN = (inN.toLong() * dstRate / srcRate).toInt()
        val out = ByteBuffer.allocate(outN * 2).order(ByteOrder.LITTLE_ENDIAN)
        val step = srcRate.toDouble() / dstRate
        var pos = 0.0
        for (i in 0 until outN) {
            val idx = pos.toInt()
            val frac = pos - idx
            val a = sb.get(idx.coerceIn(0, inN - 1)).toInt()
            val b = sb.get((idx + 1).coerceIn(0, inN - 1)).toInt()
            out.putShort((a + (b - a) * frac).toInt().toShort())
            pos += step
        }
        Timber.tag(TAG).i("resampled ${srcRate}→${dstRate} Hz ($inN→$outN samples)")
        return out.array()
    }

    private fun writeWav(file: File, pcm: ByteArray, sr: Int) {
        val raf = RandomAccessFile(file, "rw"); raf.setLength(0)
        fun w(s: String) = raf.write(s.toByteArray(Charsets.US_ASCII))
        fun i32(v: Int) = raf.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array())
        fun i16(v: Int) = raf.write(ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(v.toShort()).array())
        w("RIFF"); i32(36 + pcm.size); w("WAVE"); w("fmt "); i32(16); i16(1); i16(1)
        i32(sr); i32(sr * 2); i16(2); i16(16); w("data"); i32(pcm.size); raf.write(pcm); raf.close()
    }

    private fun post(r: () -> Unit) { android.os.Handler(android.os.Looper.getMainLooper()).post(r) }

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
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess() { Timber.tag(TAG).i("$w setOK") }
        override fun onCreateFailure(e: String?) { Timber.tag(TAG).e("$w createFail $e") }
        override fun onSetFailure(e: String?) { Timber.tag(TAG).e("$w setFail $e") }
    }

    private const val PROBE =
        "The quick brown fox jumps over the lazy dog while the river flows " +
        "gently past the old stone bridge under a bright morning sky."
}
