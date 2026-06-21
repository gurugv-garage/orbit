package dev.orbit.dock.perception

import android.content.Context
import dev.orbit.dock.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import timber.log.Timber

/**
 * Wires the on-device perception layer:
 *   - [MicCapture] → [SileroVad] (VAD events) + [PorcupineWakeWord] (wake events)
 *   - mic RMS levels for the UI meter
 *   - All events fan out via [PerceptionBus]
 *
 * The pipeline owns its own scope; `stop()` cancels everything cleanly.
 *
 * **A1 — the always-on-mic shift (docs/perception-to-brain.md).** The on-device
 * Android SpeechRecognizer is GONE. STT now runs SERVER-SIDE: the dock publishes
 * its AEC'd mic over WebRTC ([MediaStreamer]) and orbit-station's `stt-watch`
 * processor does VAD-endpointed transcription. The mic is therefore captured
 * CONTINUOUSLY here — the WebRTC ADM is never released mid-session (it used to be,
 * to hand the mic to SpeechRecognizer; that time-share is what made the streamed
 * audio glitch). One capture (the shared ADM) feeds BOTH this local pipeline
 * (VAD/wake/levels) AND the published audio track — no second mic session.
 *
 * **Tap is now the "addressed" signal, not "mic-on".** A tap still emits
 * [PerceptionEvent.WakeWord], but it no longer starts a recognizer — the mic is
 * always listening. Whoever consumes the tap (A1.2: a station turn-request) treats
 * it as "this speech is directed AT the agent." Until A1.2 lands, the tap drives
 * only the local face/UI affordances.
 *
 * v1 VAD hysteresis:
 *   - VAD `active=true` after 3 consecutive frames with p > 0.05
 *   - VAD `active=false` after 10 frames < 0.02 (~320 ms hangover)
 */
class PerceptionPipeline(private val appContext: Context) {

    private var scope: CoroutineScope? = null
    private var job: Job? = null

    // VAD hysteresis state
    private var vadActive = false
    private var aboveCount = 0
    private var belowCount = 0
    private var lastVadEmitMs = 0L  // last time we sent a VAD-active (for the keepalive)
    private var frameIndex = 0

    // True while the dock is speaking (TTS). When the (echo-cancelled) VAD goes
    // active during this window, the user is talking over the dock → barge-in.
    @Volatile private var dockSpeaking = false
    // When TTS started (ms). Barge-in ignores a grace window after this so the
    // user's trailing question + AEC settling don't self-trigger.
    @Volatile private var speakStartMs = 0L
    // Consecutive high-VAD frames during TTS — barge-in needs this sustained, so
    // brief AEC residual spikes of the dock's own voice don't trip it.
    private var bargeAbove = 0

    fun start() {
        // Guard on the SCOPE: a second start() would double-run the whole pipeline
        // (two mics, two bus subscriptions).
        if (scope != null) {
            Timber.w("PerceptionPipeline already running")
            return
        }
        val parent = SupervisorJob()
        val s = CoroutineScope(parent + Dispatchers.Default)
        scope = s

        val vad = SileroVad.fromAssets(appContext)
        val wake = PorcupineWakeWord.jarvis(appContext, BuildConfig.PORCUPINE_ACCESS_KEY)
        PerceptionBus.emit(
            PerceptionEvent.Status(
                source = "pipeline",
                message = buildString {
                    append("start: vad=")
                    append(if (vad != null) "ok" else "off")
                    append(", wake=")
                    append(if (wake != null) "ok(${wake.label})" else "off (no Porcupine key)")
                    append(", stt=server (always-on mic)")
                },
            )
        )
        // Models constructed — the dock can now hear. Clears the UI "waking up".
        PerceptionReady.set(true)

        val mic = MicCapture(appContext)
        // The mic flow runs for the LIFE of the pipeline — never cancelled for STT
        // (there is no on-device STT anymore). This keeps the shared WebRTC ADM
        // capturing continuously, so the published audio track never glitches.
        val micJob: Job = mic.frames()
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

        // Track TTS state (for barge-in detection below). No STT to pause/resume.
        val speakingJob = s.launch {
            PerceptionBus.events.collect { event ->
                if (event is PerceptionEvent.Speaking) {
                    dockSpeaking = event.active
                    if (event.active) {
                        speakStartMs = System.currentTimeMillis()
                        bargeAbove = 0
                    }
                }
            }
        }

        job = micJob

        parent.invokeOnCompletion {
            vad?.close()
            wake?.close()
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
                lastVadEmitMs = System.currentTimeMillis()
                PerceptionBus.emit(PerceptionEvent.VoiceActivity(true, p))
            } else if (vadActive && System.currentTimeMillis() - lastVadEmitMs >= VAD_KEEPALIVE_MS) {
                // KEEPALIVE: re-emit VAD active periodically WHILE the user keeps talking,
                // so the station keeps extending the listening window (it extends by
                // VAD_EXTEND_MS per event). Without this, one onset event lets the window
                // expire mid-sentence — the listening indicator turns off while you're
                // still speaking. Re-firing every VAD_KEEPALIVE_MS keeps it alive.
                lastVadEmitMs = System.currentTimeMillis()
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
        // Re-emit VAD-active every this-many ms WHILE the user keeps talking, so the
        // station's listening window (extended VAD_EXTEND_MS=4s per event) never lapses
        // mid-sentence. Kept SHORT (well under the 4s extend) so the window stays solidly
        // high while speaking — a 2s interval drifted the window down toward expiry on
        // quieter speech; 800ms keeps it pinned near the top.
        const val VAD_KEEPALIVE_MS = 800L
    }
}
