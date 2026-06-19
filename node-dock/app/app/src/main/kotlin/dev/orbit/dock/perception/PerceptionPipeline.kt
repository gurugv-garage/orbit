package dev.orbit.dock.perception

import android.content.Context
import dev.orbit.dock.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import timber.log.Timber

/**
 * Wires the perception layer end-to-end:
 *   - [MicCapture] → [SileroVad] (VAD events) + [PorcupineWakeWord] (wake events)
 *   - Wake event → [SttEngine.start()] (one utterance, auto-stops on end-of-speech)
 *   - All events fan out via [PerceptionBus]
 *
 * The pipeline owns its own scope; `stop()` cancels everything cleanly.
 *
 * v1 hysteresis:
 *   - VAD `active=true` after 3 consecutive frames with p > 0.5
 *   - VAD `active=false` after 10 frames < 0.35 (~320 ms hangover)
 *
 * STT activation:
 *   - On wake-word event: start STT (free-form utterance)
 *   - STT auto-finalizes on end-of-speech and emits Transcript(final=true)
 *   - Concurrent wake events while listening are ignored
 */
class PerceptionPipeline(private val appContext: Context) {

    private var scope: CoroutineScope? = null
    private var job: Job? = null
    private var stt: SttEngine? = null

    // VAD hysteresis state
    private var vadActive = false
    private var aboveCount = 0
    private var belowCount = 0
    private var frameIndex = 0

    @Volatile private var sttBusy = false

    // True while the dock is speaking (TTS). When the (echo-cancelled) VAD goes
    // active during this window, the user is talking over the dock → barge-in.
    @Volatile private var dockSpeaking = false
    // When TTS started (ms). Barge-in ignores a grace window after this so the
    // user's trailing question + AEC settling don't self-trigger.
    @Volatile private var speakStartMs = 0L
    // Consecutive high-VAD frames during TTS — barge-in needs this sustained, so
    // brief AEC residual spikes of the dock's own voice don't trip it.
    private var bargeAbove = 0

    // When true, the echo gate is disabled so STT stays armed through TTS — used
    // only by the AEC self-test to measure whether the dock transcribes itself.
    private val aecTestMode: Boolean get() = AecTestMode.enabled

    // ── Continuous listening session (TAP-ONLY) ───────────────────────────
    // Tap starts a session; it keeps re-arming SpeechRecognizer (one-shot) so
    // it stays listening forever. The session ends ONLY when:
    //   - a transcript is produced (→ agent turn), or
    //   - stopListening() is called (tap-to-stop / barge-in).
    // While the dock is speaking (TTS), STT is paused (echo gate) and resumes
    // when speech ends. No wake word, no VAD-wake, no timeout.
    @Volatile private var listeningActive = false

    // Set true when a final transcript is produced this session, so the
    // trailing SR "final" status doesn't emit session_ended over the agent.
    @Volatile private var gotTranscript = false

    // Continuous-conversation decision machine: re-arm the mic once after the
    // dock finishes speaking a voice-initiated turn. Pure + unit tested.
    private val autoRelisten = AutoRelisten()

    fun start() {
        // Guard on the SCOPE, not the mic job: unstick() replaces the mic job
        // at runtime, so a stale `job` reference could read inactive while the
        // pipeline is very much running — and a second start() would then
        // double-run the whole pipeline (two mics, two bus subscriptions).
        if (scope != null) {
            Timber.w("PerceptionPipeline already running")
            return
        }
        val parent = SupervisorJob()
        val s = CoroutineScope(parent + Dispatchers.Default)
        scope = s

        val vad = SileroVad.fromAssets(appContext)
        val wake = PorcupineWakeWord.jarvis(appContext, BuildConfig.PORCUPINE_ACCESS_KEY)
        stt = AndroidSpeechRecognizerStt(appContext)
        PerceptionBus.emit(
            PerceptionEvent.Status(
                source = "pipeline",
                message = buildString {
                    append("start: vad=")
                    append(if (vad != null) "ok" else "off")
                    append(", wake=")
                    append(if (wake != null) "ok(${wake.label})" else "off (no Porcupine key)")
                    append(", stt=")
                    append(stt?.label ?: "off")
                },
            )
        )
        // Models constructed — the dock can now hear. Clears the UI "waking up".
        PerceptionReady.set(true)

        val mic = MicCapture(appContext)
        // SpeechRecognizer needs exclusive access to the mic. Our continuous
        // AudioRecord (here) blocks it on some devices. Pause our capture
        // while STT is active, resume on Transcript/Error/Status(final).
        fun launchMicJob(): Job = mic.frames()
            .catch { t ->
                Timber.e(t, "mic flow failure")
                PerceptionBus.emit(PerceptionEvent.Error("mic", t))
            }
            .onEach { frame ->
                frameIndex++
                emitLevel(frame)
                vad?.let { runVad(it, frame) }
                wake?.let { runWake(it, frame) }
            }
            .launchIn(s)

        var micJob: Job = launchMicJob()

        // Helper that *always* unsticks the pipeline: clears sttBusy,
        // restarts MicCapture, and cancels any pending watchdog. Called
        // from every STT termination event and from the watchdog itself.
        var watchdog: Job? = null
        fun unstick(reason: String) {
            if (watchdog != null) {
                watchdog?.cancel()
                watchdog = null
            }
            val wasStuck = sttBusy || !micJob.isActive
            sttBusy = false
            if (!micJob.isActive) micJob = launchMicJob()
            if (wasStuck) Timber.i("pipeline unstick: $reason")
        }

        // (Re)arm the STT hang-watchdog: if no Transcript/Error/Status(final)
        // arrives within 15s, force a final so we don't get stuck.
        fun armWatchdog() {
            watchdog?.cancel()
            watchdog = s.launch {
                kotlinx.coroutines.delay(15_000)
                try { stt?.stop() } catch (_: Throwable) {}
                listeningActive = false
                unstick("watchdog timeout (15s)")
                PerceptionBus.emit(PerceptionEvent.Status(stt?.label ?: "stt", "final"))
            }
        }

        // Emit a single "session_ended" signal so the UI returns the face to
        // Idle exactly once when the whole listening session is over (NOT on
        // per-shot SR no-matches during continuous listening).
        fun emitSessionEnded() {
            PerceptionBus.emit(PerceptionEvent.Status(stt?.label ?: "stt", "session_ended"))
        }


        // STT bus subscription — track busy state via Status/Error events,
        // and pause/resume MicCapture to give STT exclusive mic access.
        val sttJob = s.launch {
            PerceptionBus.events.collect { event ->
                when (event) {
                    is PerceptionEvent.WakeWord -> {
                        // Tap-to-start. One tap = one listening shot. When SR
                        // ends (transcript / no-match / timeout) the session is
                        // over and the UI drops to idle — the user re-taps to
                        // listen again. No re-arm, no echo gate.
                        listeningActive = true
                        gotTranscript = false
                        autoRelisten.onSessionStarted()

                        // Release our mic before starting STT. cancelAndJoin()
                        // waits for the WebRTC ADM to fully release (detaching the
                        // hardware AEC effect) so SR gets a clean input path — not
                        // the silenced mic that caused "no match". The delay lets
                        // the input HAL settle after AEC teardown (heavier than a
                        // plain AudioRecord release, so a bit longer).
                        if (micJob.isActive) {
                            micJob.cancelAndJoin()
                            kotlinx.coroutines.delay(250)
                        }
                        startStt()
                        armWatchdog()
                    }
                    is PerceptionEvent.Transcript -> if (event.isFinal) {
                        // Got a real utterance → end the session; the agent
                        // turn takes over from here. Mark it so the trailing
                        // Status("final") does NOT emit session_ended (which
                        // would yank the face to Idle while the agent is
                        // driving it).
                        gotTranscript = true
                        listeningActive = false
                        autoRelisten.onVoiceTranscript()
                        unstick("transcript final")
                    }
                    is PerceptionEvent.Error -> if (event.source == stt?.label) {
                        // SR ended empty (no-match / speech-timeout / audio).
                        // One tap = one shot: do NOT re-arm. End the session so
                        // the UI honestly drops to idle; the user re-taps to
                        // listen again.
                        listeningActive = false
                        autoRelisten.onSessionEndedEmpty()
                        unstick("stt error (session over)")
                        emitSessionEnded()
                    }
                    is PerceptionEvent.Status -> if (event.message == "final" && event.source == stt?.label) {
                        // SR finalized. If a transcript was produced, the agent
                        // now owns the face — stay quiet. Otherwise the session
                        // ended empty → drop the UI to idle.
                        listeningActive = false
                        if (gotTranscript) {
                            gotTranscript = false
                        } else {
                            autoRelisten.onSessionEndedEmpty()
                            unstick("stt final (session over)")
                            emitSessionEnded()
                        }
                    }
                    is PerceptionEvent.StopListening -> {
                        // Tap-to-stop: end the session now. Cancel any pending
                        // auto-relisten so we don't re-arm after a deliberate stop.
                        listeningActive = false
                        gotTranscript = false
                        autoRelisten.onCancelled()
                        try { stt?.stop() } catch (_: Throwable) {}
                        unstick("tap-stop")
                    }
                    is PerceptionEvent.Speaking -> {
                        dockSpeaking = event.active
                        if (event.active) {
                            speakStartMs = System.currentTimeMillis()
                            bargeAbove = 0
                        }
                        // One-shot model: the listening session already ended
                        // when the transcript came in, so there's nothing to
                        // gate here. If the dock somehow starts speaking while
                        // SR is still armed (e.g. a system reply), stop SR so
                        // the mic doesn't transcribe the dock's own voice.
                        // EXCEPT in AEC test mode: we deliberately keep STT armed
                        // through TTS to measure whether AEC stops the dock from
                        // hearing itself (the echo gate would otherwise mask it).
                        if (event.active && listeningActive && !aecTestMode) {
                            listeningActive = false
                            try { stt?.stop() } catch (_: Throwable) {}
                        }
                        // Continuous conversation: when the dock finishes
                        // speaking the reply to a voice-initiated turn, re-arm
                        // the mic once so the user can keep talking hands-free.
                        // Non-voice turns (no prior session) don't re-arm.
                        if (autoRelisten.onSpeakingChanged(event.active)) {
                            Timber.i("auto-relisten: re-arming mic after reply")
                            PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(auto-relisten)"))
                        }
                    }
                    else -> {}
                }
            }
        }

        job = micJob

        parent.invokeOnCompletion {
            vad?.close()
            wake?.close()
            stt?.close()
            stt = null
            Timber.d("PerceptionPipeline scope completed")
        }
    }

    fun stop() {
        scope?.cancel()
        scope = null
        job = null
        PerceptionReady.set(false)
        PerceptionBus.emit(PerceptionEvent.VoiceActivity(false, 0f))
        PerceptionBus.emit(PerceptionEvent.AudioLevel(0f))
        vadActive = false
        aboveCount = 0
        belowCount = 0
        frameIndex = 0
        sttBusy = false
        listeningActive = false
        gotTranscript = false
    }

    /**
     * Called from outside to force-start STT (e.g., tap-to-wake handler in UI).
     */
    fun startStt() {
        if (sttBusy) {
            Timber.d("STT already busy — ignoring start request")
            return
        }
        sttBusy = true
        stt?.start()
    }

    /**
     * End an in-progress listening session immediately (tap-to-stop). Stops
     * SpeechRecognizer and clears the session. The mic (VAD/wake) resumes via
     * the normal Status(final) → unstick path, or the next tap.
     */
    fun stopListening() {
        if (!listeningActive) return
        Timber.i("stopListening (tap-stop)")
        listeningActive = false
        gotTranscript = false
        try { stt?.stop() } catch (_: Throwable) {}
    }

    // ── private ──────────────────────────────────────────────────────────

    private var peakRmsWindow = 0f
    private fun emitLevel(frame: ShortArray) {
        if (frameIndex % 3 == 0) {
            val rms = frame.rmsLevel()
            PerceptionBus.emit(PerceptionEvent.AudioLevel(rms))
            if (rms > peakRmsWindow) peakRmsWindow = rms
            // Only log every ~5s, and only the peak — OEM logcat quotas
            // (e.g. ColorOS LOG_FLOWCTRL) drop messages above ~300/min
            // per app. One line per 5s stays well under.
            if (frameIndex % 150 == 0) {
                Timber.tag("MIC_LIVE").i("frame=$frameIndex peakRms=%.3f vadActive=$vadActive".format(peakRmsWindow))
                peakRmsWindow = 0f
            }
        }
    }

    private var maxP = 0f
    private fun runVad(vad: SileroVad, frame: ShortArray) {
        val p = vad.probability(frame.toFloat32())
        if (p > maxP) maxP = p
        if (frameIndex % 150 == 0) {
            Timber.tag("VAD_LIVE").i("maxP=%.4f thresh=0.05".format(maxP))
            maxP = 0f
        }
        // Voice barge-in is DISABLED: the phone's hardware AEC is too weak — it
        // leaves the dock's own voice in the mic at VAD ~0.98, so a VAD-during-TTS
        // trigger SELF-INTERRUPTS the dock on its own speech. The fix (route TTS
        // through a WebRTC loopback so software AEC cancels it — proven in
        // EchoLoopTest, see docs/findings/barge-in-findings.md) isn't productionized yet.
        // Until then, interruption is tap-only. Keep BARGE_IN_ENABLED=false.
        @Suppress("ConstantConditionIf")
        if (BARGE_IN_ENABLED && dockSpeaking) {
            val sinceStart = System.currentTimeMillis() - speakStartMs
            if (sinceStart >= BARGE_GRACE_MS && p > BARGE_VAD_THRESH) {
                bargeAbove++
                if (bargeAbove >= BARGE_VAD_FRAMES) {
                    dockSpeaking = false
                    bargeAbove = 0
                    Timber.i("barge-in: sustained voice during TTS (p=%.3f)".format(p))
                    PerceptionBus.emit(PerceptionEvent.BargeIn)
                }
            } else if (p <= BARGE_VAD_THRESH) {
                bargeAbove = 0
            }
        }

        // General VAD-active state (drives the user/silent indicator).
        if (p > 0.05f) {
            aboveCount++
            belowCount = 0
            if (!vadActive && aboveCount >= 3) {
                vadActive = true
                PerceptionBus.emit(PerceptionEvent.VoiceActivity(true, p))
            }
        } else if (p < 0.02f) {
            belowCount++
            aboveCount = 0
            if (vadActive && belowCount >= 10) {
                vadActive = false
                PerceptionBus.emit(PerceptionEvent.VoiceActivity(false, p))
            }
        }
    }

    private fun runWake(wake: PorcupineWakeWord, frame: ShortArray) {
        val idx = wake.process(frame)
        if (idx >= 0) {
            PerceptionBus.emit(PerceptionEvent.WakeWord(wake.label))
        }
    }

    private companion object {
        // Barge-in (VAD during TTS) tuning. Initial values from on-device data:
        // dock's AEC'd residual peaks ~0.18 briefly; real speech is sustained ~1.0.
        // Validated/iterated via the automated self-interrupt test (AecSelfTest).
        // Voice barge-in needs strong AEC the hardware path doesn't provide; it
        // self-interrupts. Off until the WebRTC-loopback AEC is productionized.
        const val BARGE_IN_ENABLED = false
        const val BARGE_GRACE_MS = 400L     // ignore barge-in this long after TTS start
        const val BARGE_VAD_THRESH = 0.6f   // prob must exceed this (well above residual)
        const val BARGE_VAD_FRAMES = 5      // sustained ~150 ms (vs brief residual spikes)
    }
}
