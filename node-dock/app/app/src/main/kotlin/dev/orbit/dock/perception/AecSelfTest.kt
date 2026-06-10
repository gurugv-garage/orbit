package dev.orbit.dock.perception

import dev.orbit.dock.tts.Speaker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import timber.log.Timber

/**
 * Automated acoustic-echo-cancellation probe — **uses STT as the detector**
 * (not VAD, which is independently unreliable). Speaks a long known passage out
 * the speaker (the real [Speaker]/TTS path on the voice-comm stream the AEC
 * references) while the **SpeechRecognizer listens**. Then it inspects what STT
 * transcribed:
 *
 *  - If AEC works, the dock's own voice is cancelled before reaching the mic, so
 *    STT hears (almost) nothing → empty/near-empty transcript → PASS.
 *  - If echo leaks, STT transcribes fragments of what the dock just said → FAIL
 *    (and the dock would talk to itself / barge-in would self-trigger).
 *
 * This is the ground-truth "does the dock hear itself" test: STT is what
 * actually consumes the mic, so its transcript is the real answer. Must be run
 * **out loud** on the speaker (not headphones, not muted).
 *
 * Verdict + any leaked transcript go to logcat under the AEC_TEST tag and to
 * [AecTestState] for the DEBUG tab. Trigger via the debug button
 * (PerceptionEvent.RunAecTest) or `adb shell am broadcast`.
 */
class AecSelfTest(
    private val speaker: Speaker,
    private val scope: CoroutineScope,
) {
    @Volatile private var running = false

    enum class Outcome { PASS, FAIL, INCONCLUSIVE, RUNNING }

    data class Result(
        val outcome: Outcome,
        val message: String,
        val peakRms: Float = 0f,
        /** What STT transcribed during the dock's own speech (the leak). */
        val heard: String = "",
    )

    /** Mic RMS must exceed this during playback to confirm the speaker actually
     *  produced sound — otherwise an empty transcript proves nothing. */
    private val minPlaybackRms = 0.01f

    fun run() {
        if (running) {
            Timber.tag(TAG).w("already running")
            return
        }
        running = true
        AecTestState.publish(Result(Outcome.RUNNING, "speaking — listening for echo…"))
        scope.launch {
            Timber.tag(TAG).i("START — speaking passage with STT armed; what does the mic hear?")
            // Keep STT listening THROUGH the dock's speech (bypass the echo gate)
            // so we actually measure AEC, not the gate.
            AecTestMode.enabled = true

            var peakRms = 0f
            var spoke = false   // TTS actually started (onStart → Speaking(true))
            val heard = StringBuilder()

            // Collect: did TTS actually start? what did STT transcribe?
            val collector = PerceptionBus.events
                .onEach { ev ->
                    when (ev) {
                        is PerceptionEvent.Speaking -> if (ev.active) spoke = true
                        is PerceptionEvent.Transcript ->
                            if (ev.isFinal && ev.text.isNotBlank()) {
                                if (heard.isNotEmpty()) heard.append(" ")
                                heard.append(ev.text.trim())
                            }
                        is PerceptionEvent.AudioLevel ->
                            if (ev.level > peakRms) peakRms = ev.level
                        else -> {}
                    }
                }
                .launchIn(scope)

            // Arm STT (same path a tap uses) and speak a long passage over it.
            PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(aec-test)"))
            delay(300)
            speaker.enqueueSentence(PROBE_PASSAGE)

            // Wait until TTS actually starts speaking (it can cold-start for
            // several seconds on first run) before trusting the measurement —
            // otherwise we'd measure silence and falsely pass.
            var waited = 0L
            while (!spoke && waited < SPEAK_TIMEOUT_MS) {
                delay(200)
                waited += 200
            }
            // Let it speak for the measurement window (only if it started).
            if (spoke) delay(PLAYBACK_MS)

            collector.cancel()
            speaker.stop()
            PerceptionBus.emit(PerceptionEvent.StopListening)
            AecTestMode.enabled = false
            running = false

            val leaked = heard.toString()
            val (outcome, verdict) = when {
                !spoke -> Outcome.INCONCLUSIVE to
                    "TTS never started (still loading / muted?) — retry in a moment"
                peakRms <= minPlaybackRms -> Outcome.INCONCLUSIVE to
                    "TTS started but no audio energy (volume up? muted?) — retry"
                leaked.isBlank() -> Outcome.PASS to
                    "dock spoke but STT heard nothing → AEC cancelled the dock's own voice"
                else -> Outcome.FAIL to
                    "STT transcribed the dock's own speech → echo leaking"
            }
            AecTestState.publish(Result(outcome, verdict, peakRms, leaked))
            Timber.tag(TAG).i(
                "RESULT: %s — %s | spoke=%s peakRms=%.4f heard=\"%s\"".format(
                    outcome, verdict, spoke, peakRms, leaked,
                ),
            )
        }
    }

    companion object {
        const val TAG = "AEC_TEST"
        // Long enough that any echo leak produces transcribable words.
        private const val PROBE_PASSAGE =
            "The quick brown fox jumps over the lazy dog while the sun sets " +
            "slowly behind the distant mountains and the river flows on."
        private const val PLAYBACK_MS = 8_000L
        // TTS can cold-start for several seconds on the first run after launch.
        private const val SPEAK_TIMEOUT_MS = 12_000L
    }
}
