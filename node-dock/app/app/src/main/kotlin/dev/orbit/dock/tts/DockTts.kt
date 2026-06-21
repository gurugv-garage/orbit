package dev.orbit.dock.tts

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import dev.orbit.dock.perception.WebRtcAudio
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.VoiceProfile
import timber.log.Timber
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android TextToSpeech wrapper with sentence-level streaming.
 *
 * Producers call [enqueueSentence] as each chunk becomes ready
 * (after the LLM stream emits a sentence boundary). TTS plays them
 * back-to-back; gaps between sentences are usually < 100 ms with the
 * Android TTS engine.
 *
 * Lifecycle:
 *   - Init is async; until `ready` is true, enqueueSentence buffers.
 *   - On utterance completion, if the queue is empty we call
 *     [FaceController.silence] so the face returns to idle naturally.
 */
class DockTts(
    context: Context,
    private val face: FaceController,
    private val onSpeakingChanged: (Boolean) -> Unit = {},
) : Speaker {
    private val appCtx = context.applicationContext

    private val ready = AtomicBoolean(false)
    private val pending = mutableListOf<String>()
    // The active per-face voice. Buffered until the engine is ready, then
    // (re-)applied whenever the face changes. setPitch/setSpeechRate affect
    // SUBSEQUENTLY queued utterances, so a mid-stream face swap takes effect
    // from the next sentence — the desired behaviour.
    @Volatile private var voice: VoiceProfile = VoiceProfile()
    private val activeUtterances = mutableSetOf<String>()
    // A1: per-utterance synth output files (id → wav) awaiting render, and a
    // scheduler that ends the speaking signal at the PCM's real playback duration.
    private val synthFiles = ConcurrentHashMap<String, File>()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    // Running playback clock: when the audio queued so far finishes (ms epoch).
    // Sentences synthesize near-simultaneously but play sequentially, so each new
    // utterance's end is scheduled relative to this, not `now`.
    private val playbackLock = Any()
    @Volatile private var playbackEndsAt = 0L
    // Rising/falling edges of the public "speaking" signal. Turn-aware so the
    // gap between streamed sentences never reads as "stopped speaking" — that
    // false edge mid-reply is what re-armed the mic over the dock's own voice.
    private val gate = SpeakingEdgeGate()

    private val tts: TextToSpeech = TextToSpeech(appCtx) { status ->
        if (status == TextToSpeech.SUCCESS) {
            Timber.d("TTS init success")
            // Try US English first; falls back if unavailable.
            val result = tts?.setLanguage(Locale.US) ?: TextToSpeech.LANG_NOT_SUPPORTED
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Timber.w("TTS lang not supported (result=$result) — using default")
            }
            // Apply the active face's voice (pitch/rate/engine voice). Defaults
            // reproduce the historical 1.0 rate / 1.05 pitch.
            applyVoiceLocked()
            // A1.2 AEC fix: play TTS on USAGE_VOICE_COMMUNICATION so it joins the
            // SAME audio world WebRTC's mic capture uses. Measured (with the
            // always-on-mic shift): the old USAGE_ASSISTANT/media routing was NOT
            // referenced by the voice-comm echo canceller, so the station's STT
            // transcribed the dock's own TTS verbatim. Putting playback on the
            // voice-comm path gives the echo canceller the reference it needs to
            // subtract our TTS from the streamed mic. (The old comment claimed
            // assistant output was cancelled "against the speaker mix" — empirically
            // false in the new path.) If routing ever goes to the earpiece on some
            // OEM, revisit by routing TTS PCM through WebRTC's ADM playout directly.
            tts?.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            ready.set(true)
            flushPending()
        } else {
            Timber.e("TTS init failed (status=$status)")
        }
    }.apply {
        setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                // This is SYNTHESIS start (file being written), NOT playback. The
                // speaking-on edge + face.speak() now fire at PLAYBACK start, in
                // feedSynthesized(), so we don't mark speaking here.
                Timber.v("TTS synth start: $utteranceId")
            }

            override fun onDone(utteranceId: String?) {
                // Synthesis complete → the WAV is ready. Render it through WebRTC
                // (plays out + AEC reference); playback timing drives the rest.
                Timber.v("TTS synth done: $utteranceId")
                utteranceId?.let { feedSynthesized(it) }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                Timber.w("TTS error: $utteranceId")
                // Must run the same cleanup as onDone — otherwise a failed
                // utterance leaves the face stuck in Speaking and the agent
                // stuck in AgentState.Speaking, which keeps the wake-on-look
                // gate (state==Idle) closed forever. That's the "says
                // listening but doesn't listen until I tap" bug.
                finishUtterance(utteranceId)
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                Timber.w("TTS error: $utteranceId code=$errorCode")
                finishUtterance(utteranceId)
            }

            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                // tts.stop() routes the current utterance HERE, not onDone/
                // onError — without this override a stop left the utterance
                // forever "active" and the speaking signal never fell.
                Timber.v("TTS stopped: $utteranceId interrupted=$interrupted")
                finishUtterance(utteranceId)
            }
        })
    }

    /**
     * Shared cleanup for an utterance ending (done / error / stopped). Removes
     * it from the active set; the speaking signal falls only when the gate
     * says the whole speech run is over (queue drained AND turn closed) — a
     * momentarily-empty queue mid-turn is just the LLM still streaming.
     */
    private fun finishUtterance(utteranceId: String?) {
        if (utteranceId != null) synchronized(activeUtterances) { activeUtterances.remove(utteranceId) }
        if (queueDrained() && gate.onQueueDrained()) {
            face.silence()
            onSpeakingChanged(false)
        }
    }

    private fun queueDrained(): Boolean =
        synchronized(activeUtterances) { activeUtterances.isEmpty() } &&
            synchronized(pending) { pending.isEmpty() }

    /** A turn opened: sentences will stream in; gaps are not end-of-speech. */
    override fun onTurnBegin() {
        gate.onTurnOpened()
    }

    /** The turn's loop ended: once the queue drains (or if it already has),
     *  the speaking signal falls. */
    override fun onTurnEnd() {
        if (gate.onTurnClosed(queueDrained())) {
            face.silence()
            onSpeakingChanged(false)
        }
    }

    override fun enqueueSentence(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        if (!ready.get()) {
            synchronized(pending) { pending.add(trimmed) }
            return
        }
        speakNow(trimmed)
    }

    override fun stop() {
        try {
            tts.stop()
            // A1: also drop any TTS PCM still queued in the WebRTC render loopback,
            // else a barge-in/cancel would keep playing the already-synthesized tail.
            WebRtcAudio.stopTtsRender()
            synchronized(activeUtterances) { activeUtterances.clear() }
            synchronized(pending) { pending.clear() }
            // delete any orphaned synth WAVs (synthesized but not yet rendered) so a
            // barge-in mid-synthesis doesn't leak files in cacheDir; reset the clock.
            synthFiles.values.forEach { runCatching { it.delete() } }
            synthFiles.clear()
            synchronized(playbackLock) { playbackEndsAt = 0L }
        } catch (t: Throwable) {
            Timber.w(t, "TTS stop failed")
        }
        // A hard stop ends speech NOW (even mid-turn): without this falling
        // edge the pipeline kept believing the dock was talking after a
        // long-press/barge-in, which suppressed auto-listen until the next turn.
        if (gate.onStopped()) {
            face.silence()
            onSpeakingChanged(false)
        }
    }

    fun shutdown() {
        try {
            tts.stop()
            tts.shutdown()
        } catch (_: Throwable) {
        }
    }

    /**
     * Set the voice for subsequent speech (called when the active face changes).
     * Safe to call before the engine is ready — the profile is stored and
     * applied on init.
     */
    fun applyVoice(profile: VoiceProfile) {
        voice = profile
        if (ready.get()) applyVoiceLocked()
    }

    private fun applyVoiceLocked() {
        val v = voice
        runCatching {
            tts.setSpeechRate(v.rate)
            tts.setPitch(v.pitch)
            if (v.voiceName != null) {
                val match = tts.voices?.firstOrNull { it.name == v.voiceName }
                if (match != null) tts.voice = match
                else Timber.w("TTS voice '${v.voiceName}' not found — keeping default")
            }
        }.onFailure { Timber.w(it, "applyVoice failed") }
    }

    private fun flushPending() {
        synchronized(pending) {
            for (chunk in pending) speakNow(chunk)
            pending.clear()
        }
    }

    // A1 (always-on-mic AEC): speech is RENDERED THROUGH WebRTC, not played by
    // Android TTS directly. We synthesizeToFile → PCM → resample to 16k → feed
    // WebRtcAudio.renderTtsPcm, which plays it out the speaker AND makes it the
    // software-AEC reference, so the station's STT no longer transcribes the dock's
    // own voice. The speaking signal (face + the station gate) is driven by PLAYBACK
    // timing (PCM duration), NOT synthesis completion (synthesizeToFile's onDone
    // fires when the file is written, well before playback ends).
    private fun speakNow(text: String) {
        val id = UUID.randomUUID().toString()
        synchronized(activeUtterances) { activeUtterances.add(id) }
        val file = File(appCtx.cacheDir, "tts-$id.wav")
        synthFiles[id] = file
        val params = Bundle().apply {
            putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id)
        }
        // onStart/onDone of synthesis are handled by the progress listener:
        //  - we tie the SPEAKING-ON edge + face.speak() to playback start (in
        //    feedSynthesized), not synth onStart;
        //  - synth onDone → read+resample+feed the loopback.
        tts.synthesizeToFile(text, params, file, id)
    }

    /** Synthesis finished for [id]: read the WAV, resample to 16k, render through
     *  WebRTC, and schedule the utterance's end based on playback duration. */
    private fun feedSynthesized(id: String) {
        val file = synthFiles.remove(id) ?: return
        val pcm16 = runCatching { readWavResampledTo16k(file) }.getOrNull()
        runCatching { file.delete() }
        if (pcm16 == null || pcm16.isEmpty()) { finishUtterance(id); return }
        // playback-start edge (the real "now speaking").
        face.speak()
        if (gate.onUtteranceStarted()) onSpeakingChanged(true)
        WebRtcAudio.renderTtsPcm(appCtx, pcm16)
        // Schedule this utterance's end. Sentences synthesize near-simultaneously but
        // play SEQUENTIALLY from the shared render queue, so each finish must wait for
        // the audio queued AHEAD of it — schedule from a running playback clock, not
        // from `now` (else all timers fire at once and speaking falls mid-reply).
        val playMs = pcm16.size.toLong() / 2 * 1000 / 16_000
        val startAt = synchronized(playbackLock) {
            val base = maxOf(System.currentTimeMillis(), playbackEndsAt)
            playbackEndsAt = base + playMs
            base
        }
        val endInMs = (startAt - System.currentTimeMillis()) + playMs + 150 // + small tail
        scheduler.schedule({ finishUtterance(id) }, endInMs.coerceAtLeast(0), java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /** Read a TTS-engine WAV (its own rate, e.g. 24k) → mono PCM-16 resampled to 16k. */
    private fun readWavResampledTo16k(file: File): ByteArray {
        val all = file.readBytes()
        if (all.size <= 44) return ByteArray(0)
        val srcRate = java.nio.ByteBuffer.wrap(all, 24, 4)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN).int
        val pcm = all.copyOfRange(44, all.size)
        return if (srcRate == 16_000) pcm else resamplePcm16(pcm, srcRate, 16_000)
    }

    /** Linear-interpolation resample of mono PCM-16 LE. */
    private fun resamplePcm16(src: ByteArray, srcRate: Int, dstRate: Int): ByteArray {
        if (srcRate == dstRate) return src
        val sb = java.nio.ByteBuffer.wrap(src).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val inN = src.size / 2
        val outN = (inN.toLong() * dstRate / srcRate).toInt()
        val out = java.nio.ByteBuffer.allocate(outN * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val step = srcRate.toDouble() / dstRate
        var pos = 0.0
        for (i in 0 until outN) {
            val idx = pos.toInt(); val frac = pos - idx
            val a = sb.get(idx.coerceIn(0, inN - 1)).toInt()
            val b = sb.get((idx + 1).coerceIn(0, inN - 1)).toInt()
            out.putShort((a + (b - a) * frac).toInt().toShort()); pos += step
        }
        return out.array()
    }
}
