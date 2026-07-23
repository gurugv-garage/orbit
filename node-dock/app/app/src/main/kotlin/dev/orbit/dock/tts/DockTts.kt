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
    /** Periodic re-assert while speaking (see SPEAK_KEEPALIVE_MS). Separate from
     *  onSpeakingChanged: a keepalive is NOT an edge — routing it through the
     *  edge callback re-emitted Speaking(true) on the PerceptionBus every tick,
     *  resetting the barge-in grace window + counters each time. */
    private val onSpeakingKeepalive: () -> Unit = {},
    /** Observability tap (→ RemoteBrain.clientEvt): tts-pause / tts-resume /
     *  tts-auto-resume-timeout / tts-play-start + the gate's speak-edge. */
    private val onClientEvt: (event: String, detail: Map<String, Any?>) -> Unit = { _, _ -> },
) : Speaker {
    private val appCtx = context.applicationContext

    private val ready = AtomicBoolean(false)
    private val pending = mutableListOf<Pair<String, (() -> Unit)?>>()
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
    private val gate = SpeakingEdgeGate().apply {
        onEdge = { rising -> onClientEvt("speak-edge", mapOf("rising" to rising)) }
    }
    // Pause/continue (the barge-in "polite pause"). Playback is held at the PCM
    // drain (WebRtcAudio.pauseTtsRender) so resume is sample-exact. The speaking
    // signal must NOT fall while held — the station would read SpeakEnd, settle
    // the turn, and drain the busy queue over a reply that's still mid-flight —
    // so every utterance-finish timer is cancelled on pause and rescheduled
    // shifted by the held duration on resume. Synthesis completing DURING a
    // pause is deferred (pausedFeeds) so no timer is ever scheduled while held.
    private class FinishTimer(
        @Volatile var endsAtMs: Long,
        @Volatile var future: java.util.concurrent.ScheduledFuture<*>?,
    )
    private val finishTimers = ConcurrentHashMap<String, FinishTimer>()
    // Fix 5: per-utterance PLAYBACK-START hooks (a sentence's inline mood fires
    // when its audio begins, not when the station parsed it). Same pause/resume
    // discipline as the finish timers: held futures are cancelled and re-
    // scheduled shifted by the held duration, so a mood can't land mid-pause.
    private class StartTimer(
        @Volatile var atMs: Long,
        @Volatile var future: java.util.concurrent.ScheduledFuture<*>?,
        val run: () -> Unit,
    )
    private val startTimers = ConcurrentHashMap<String, StartTimer>()
    private val startHooks = ConcurrentHashMap<String, () -> Unit>()
    private val pauseLock = Any()
    @Volatile private var paused = false
    private var pausedAtMs = 0L
    private val pausedFeeds = mutableListOf<String>()
    // SAFETY: a hold whose release frame never arrives (WS blip, station
    // restart mid-hold — its bargeHolds map is in-memory, and #sendToVoice
    // silently drops frames to an offline dock) must not wedge the dock
    // paused forever: with the keepalive still re-asserting speaking, the
    // station's SPEAK_MAX_MS backstop would never fire either. Auto-resume
    // after HOLD_MAX_MS (> the station's 6s barge timeout).
    private var holdTimeout: java.util.concurrent.ScheduledFuture<*>? = null
    // SPEAKING KEEPALIVE: while the speaking signal is up (including a pause/hold),
    // re-assert it every SPEAK_KEEPALIVE_MS. The station's conversation state bounds
    // SPEAKING with a safety cap (SPEAK_MAX_MS, 30s) that a single rising edge never
    // refreshes — a reply whose real playback runs past the cap (long story, or a
    // hold stretching it) expired the mode mid-audio: the station settled the turn,
    // drained the busy queue, and a NEW reply queued behind the still-playing old
    // one (live 2026-07-15). The keepalive keeps the station's model tied to the
    // truth: speaking lasts exactly as long as audio actually plays. (The station's
    // STT echo-gate window, SPEAK_ON_WINDOW_MS=6s, always assumed this keepalive.)
    @Volatile private var speakingUp = false
    private var keepaliveTask: java.util.concurrent.ScheduledFuture<*>? = null

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

    /** Rising edge of the public speaking signal: assert it + start the keepalive. */
    private fun speakingRose() {
        synchronized(pauseLock) {
            speakingUp = true
            if (keepaliveTask == null) {
                keepaliveTask = scheduler.scheduleWithFixedDelay(
                    { if (speakingUp) onSpeakingKeepalive() },
                    SPEAK_KEEPALIVE_MS, SPEAK_KEEPALIVE_MS, java.util.concurrent.TimeUnit.MILLISECONDS,
                )
            }
        }
        onSpeakingChanged(true)
    }

    /** Falling edge: stop the keepalive FIRST so a late tick can't re-assert
     *  speaking after the signal fell. */
    private fun speakingFell() {
        synchronized(pauseLock) {
            speakingUp = false
            keepaliveTask?.cancel(false)
            keepaliveTask = null
        }
        onSpeakingChanged(false)
    }

    /**
     * Shared cleanup for an utterance ending (done / error / stopped). Removes
     * it from the active set; the speaking signal falls only when the gate
     * says the whole speech run is over (queue drained AND turn closed) — a
     * momentarily-empty queue mid-turn is just the LLM still streaming.
     */
    private fun finishUtterance(utteranceId: String?) {
        if (utteranceId != null) synchronized(activeUtterances) { activeUtterances.remove(utteranceId) }
        // An engine-side end (onStop/onError) may arrive while a playback finish
        // timer is still pending — kill it so it can't re-run finish later. The
        // start hook dies with it: a mood must not land for audio that never played.
        if (utteranceId != null) {
            finishTimers.remove(utteranceId)?.future?.cancel(false)
            startTimers.remove(utteranceId)?.future?.cancel(false)
            startHooks.remove(utteranceId)
        }
        if (queueDrained() && gate.onQueueDrained()) {
            face.silence()
            speakingFell()
        }
    }

    private fun queueDrained(): Boolean =
        synchronized(activeUtterances) { activeUtterances.isEmpty() } &&
            synchronized(pending) { pending.isEmpty() }

    /** A turn opened: sentences will stream in; gaps are not end-of-speech. */
    override fun onTurnBegin() {
        // A stale barge hold must never leak into a NEW reply: a hold placed
        // just as the previous reply drained (station mode lags real playback)
        // would defer every sentence of this turn into pausedFeeds — a silent
        // reply until the hold times out. New turn ⇒ start unpaused.
        resume()
        gate.onTurnOpened()
    }

    /** The turn's loop ended: once the queue drains (or if it already has),
     *  the speaking signal falls. */
    override fun onTurnEnd() {
        if (gate.onTurnClosed(queueDrained())) {
            face.silence()
            speakingFell()
        }
    }

    override fun enqueueSentence(text: String) = enqueueSentence(text, null)

    override fun enqueueSentence(text: String, onPlaybackStart: (() -> Unit)?) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        if (!ready.get()) {
            synchronized(pending) { pending.add(trimmed to onPlaybackStart) }
            return
        }
        speakNow(trimmed, onPlaybackStart)
    }

    override fun stop() {
        try {
            tts.stop()
            // A pause must not survive a stop: clear the hold + every held finish
            // timer BEFORE draining, so the next reply starts unpaused.
            // (stopTtsRender below also releases the PCM-drain hold.)
            synchronized(pauseLock) {
                paused = false
                holdTimeout?.cancel(false)
                holdTimeout = null
                finishTimers.values.forEach { it.future?.cancel(false) }
                finishTimers.clear()
                startTimers.values.forEach { it.future?.cancel(false) }
                startTimers.clear()
                startHooks.clear()
                pausedFeeds.clear()
            }
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
            speakingFell()
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
            for ((chunk, hook) in pending) speakNow(chunk, hook)
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
    private fun speakNow(text: String, onPlaybackStart: (() -> Unit)? = null) {
        val id = UUID.randomUUID().toString()
        synchronized(activeUtterances) { activeUtterances.add(id) }
        if (onPlaybackStart != null) startHooks[id] = onPlaybackStart
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
        // Held mid-reply? Defer — the WAV stays in synthFiles and is fed on
        // resume, so its finish timer is computed against the resumed clock.
        synchronized(pauseLock) {
            if (paused) { pausedFeeds.add(id); return }
        }
        val file = synthFiles.remove(id) ?: return
        val pcm16 = runCatching { readWavResampledTo16k(file) }.getOrNull()
        runCatching { file.delete() }
        if (pcm16 == null || pcm16.isEmpty()) { finishUtterance(id); return }
        // playback-start edge (the real "now speaking").
        face.speak()
        if (gate.onUtteranceStarted()) {
            speakingRose()
            onClientEvt("tts-play-start", emptyMap())
        }
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
        // Fix 5: this utterance's playback-start hook (its inline mood) fires
        // when ITS audio reaches the speaker — the same clock the finish rides.
        startHooks.remove(id)?.let { scheduleStart(id, startAt, it) }
        scheduleFinish(id, startAt + playMs + 150) // + small tail
    }

    /** Schedule an utterance's playback-start hook at the absolute [atMs],
     *  tracked so a pause can cancel it and a resume can reschedule it shifted
     *  (same discipline as the finish timers). */
    private fun scheduleStart(id: String, atMs: Long, run: () -> Unit) {
        synchronized(pauseLock) {
            val timer = StartTimer(atMs, null, run)
            startTimers[id] = timer
            if (!paused) timer.future = scheduleStartRunnable(id, timer)
        }
    }

    private fun scheduleStartRunnable(id: String, timer: StartTimer): java.util.concurrent.ScheduledFuture<*> {
        val delay = (timer.atMs - System.currentTimeMillis()).coerceAtLeast(0)
        return scheduler.schedule({
            // Same race guard as the finish path: a pause landing while this
            // task starts re-holds the hook (resume reschedules it) instead of
            // firing a mood into a held reply.
            synchronized(pauseLock) {
                if (paused) {
                    timer.future = null
                    return@schedule
                }
                startTimers.remove(id)
            }
            runCatching(timer.run).onFailure { Timber.w(it, "playback-start hook failed") }
        }, delay, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /** Schedule [finishUtterance] at the absolute [endsAtMs], tracked so a
     *  pause can cancel it and a resume can reschedule it shifted. */
    private fun scheduleFinish(id: String, endsAtMs: Long) {
        synchronized(pauseLock) {
            val timer = FinishTimer(endsAtMs, null)
            finishTimers[id] = timer
            if (!paused) timer.future = scheduleFinishRunnable(id, endsAtMs)
        }
    }

    private fun scheduleFinishRunnable(id: String, endsAtMs: Long): java.util.concurrent.ScheduledFuture<*> {
        val delay = (endsAtMs - System.currentTimeMillis()).coerceAtLeast(0)
        return scheduler.schedule({
            // RACE GUARD: pause() cancels with cancel(false), which can't stop a
            // task that already started. Re-check under the lock — if a hold
            // landed while this task was starting, RE-HOLD the finish (resume
            // reschedules it) instead of dropping the speaking signal mid-pause,
            // which would let the station settle the turn over held audio.
            synchronized(pauseLock) {
                if (paused) {
                    finishTimers[id] = FinishTimer(System.currentTimeMillis(), null)
                    return@schedule
                }
                finishTimers.remove(id)
            }
            finishUtterance(id)
        }, delay, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /**
     * Hold speech mid-reply (the barge-in "polite pause"): playback goes silent
     * within one audio buffer, but the queue, the speaking signal, and the turn
     * all stay up — the station still sees SPEAKING, so an STT final arriving
     * during the pause routes through the stop-intent path ("wait"/"stop"), and
     * anything else queues for settle as usual. [resume] continues sample-exact.
     * A [stop] (station cancel / tap) while paused tears everything down.
     */
    override fun pause() {
        synchronized(pauseLock) {
            if (paused) return
            paused = true
            pausedAtMs = System.currentTimeMillis()
            WebRtcAudio.pauseTtsRender()
            for (t in finishTimers.values) { t.future?.cancel(false); t.future = null }
            for (t in startTimers.values) { t.future?.cancel(false); t.future = null }
            holdTimeout = scheduler.schedule({
                Timber.w("TTS hold exceeded ${HOLD_MAX_MS}ms with no release — auto-resuming")
                doResume(auto = true)
            }, HOLD_MAX_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            Timber.i("TTS paused (${finishTimers.size} finish timers held)")
        }
        onClientEvt("tts-pause", emptyMap())
    }

    /** Continue speech held by [pause], shifting the playback clock and every
     *  finish timer by the held duration, then feeding any synthesis that
     *  completed while held. */
    override fun resume() = doResume(auto = false)

    private fun doResume(auto: Boolean) {
        val deferred: List<String>
        val shift: Long
        synchronized(pauseLock) {
            if (!paused) return
            shift = System.currentTimeMillis() - pausedAtMs
            paused = false
            holdTimeout?.cancel(false)
            holdTimeout = null
            synchronized(playbackLock) { playbackEndsAt += shift }
            for ((id, t) in finishTimers) {
                t.endsAtMs += shift
                t.future = scheduleFinishRunnable(id, t.endsAtMs)
            }
            for ((id, t) in startTimers) {
                t.atMs += shift
                t.future = scheduleStartRunnable(id, t)
            }
            WebRtcAudio.resumeTtsRender()
            deferred = pausedFeeds.toList()
            pausedFeeds.clear()
            Timber.i("TTS resumed after ${shift}ms (${deferred.size} deferred feeds)")
        }
        onClientEvt(if (auto) "tts-auto-resume-timeout" else "tts-resume", mapOf("heldMs" to shift))
        // Feed on the scheduler, not the caller's thread — a release arrives on
        // the WS frame path (or the UI), and each feed is a WAV read + resample.
        deferred.forEach { id -> scheduler.execute { feedSynthesized(id) } }
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

    private companion object {
        // Re-assert speech-status while speaking. Must stay under the station's
        // echo-gate window (SPEAK_ON_WINDOW_MS=6s) and well under its SPEAKING
        // safety cap (SPEAK_MAX_MS=30s), both of which this keepalive refreshes.
        const val SPEAK_KEEPALIVE_MS = 5_000L
        // Max time a hold may sit without a release before auto-resuming.
        // Must exceed the station's BARGE_MAX_HOLD_MS (6s) so the station's
        // timeout normally wins and this only catches a LOST release.
        const val HOLD_MAX_MS = 8_000L
    }
}
