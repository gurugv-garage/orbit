package dev.orbit.dock.perception

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import timber.log.Timber

/**
 * STT using Android's built-in [SpeechRecognizer] (Google's cloud STT on most devices).
 *
 * Notes:
 *   - Must be constructed + driven on a Looper thread. We pin to the main thread.
 *   - `EXTRA_PARTIAL_RESULTS=true` gives us live partial transcripts.
 *   - It auto-stops when it detects end-of-speech; we also handle external `stop()`.
 *   - On API 31+ the recognition service needs internet; "offline" recognition
 *     exists on Pixels but is a separate code path we don't pursue yet.
 *
 * Emits to [PerceptionBus]:
 *   - [PerceptionEvent.Transcript] with `isFinal=false` for partials
 *   - [PerceptionEvent.Transcript] with `isFinal=true` on completion
 *   - [PerceptionEvent.Error] on recognizer errors
 */
class AndroidSpeechRecognizerStt(
    appContext: Context,
) : SttEngine, RecognitionListener {

    override val label: String = "speech-recognizer"

    private val main = Handler(Looper.getMainLooper())
    private val recognizer: SpeechRecognizer? = if (SpeechRecognizer.isRecognitionAvailable(appContext)) {
        SpeechRecognizer.createSpeechRecognizer(appContext)
    } else {
        Timber.w("SpeechRecognizer not available on this device — STT will be off")
        null
    }
    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        // Give the user time to start speaking AFTER the tap/beep. The default
        // "no speech" timeout is ~2-3s, which is why "tap, then talk a moment
        // later" was missed — SR gave up (beep-down) before the user spoke.
        // These extend the silence-before-speech and end-of-speech windows.
        // (Hints; OEM recognizers may clamp them, but they help on most.)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 6_000L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1_500L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1_500L)
    }

    @Volatile private var listening = false

    init {
        main.post { recognizer?.setRecognitionListener(this) }
    }

    override fun start() {
        if (recognizer == null) return
        main.post {
            if (listening) {
                Timber.d("SR already listening")
                return@post
            }
            try {
                recognizer.startListening(intent)
                listening = true
                PerceptionBus.emit(PerceptionEvent.Status(label, "started"))
            } catch (t: Throwable) {
                PerceptionBus.emit(PerceptionEvent.Error(label, t))
            }
        }
    }

    override fun stop() {
        if (recognizer == null) return
        main.post {
            if (!listening) return@post
            try {
                recognizer.stopListening()
            } catch (t: Throwable) {
                Timber.w(t, "stop failed")
            }
        }
    }

    override fun close() {
        main.post {
            try {
                if (listening) recognizer?.cancel()
            } catch (_: Throwable) {}
            try { recognizer?.destroy() } catch (_: Throwable) {}
            listening = false
        }
    }

    // ── RecognitionListener ──────────────────────────────────────────────

    override fun onReadyForSpeech(params: Bundle?) {
        // SR is now actually armed and the device plays the "ready" beep.
        // Emit armed=true so the UI's "listening" exactly matches the beep.
        Timber.i("STT[$label] READY (armed, beep up)")
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = true))
    }

    override fun onBeginningOfSpeech() {
        Timber.i("STT[$label] speech BEGIN (user started talking)")
    }

    override fun onRmsChanged(rmsdB: Float) {
        // Could feed AudioLevel here, but our mic pipeline already does it.
    }

    override fun onBufferReceived(buffer: ByteArray?) {}

    override fun onEndOfSpeech() {
        Timber.i("STT[$label] END-OF-SPEECH (beep down)")
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = false))
    }

    override fun onError(error: Int) {
        listening = false
        val msg = errorMessage(error)
        Timber.w("STT[$label] ERROR: $msg ($error) — disarmed")
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = false))
        PerceptionBus.emit(PerceptionEvent.Error(label, RuntimeException(msg)))
    }

    override fun onPartialResults(partialResults: Bundle?) {
        val txt = firstResult(partialResults) ?: return
        if (txt.isNotBlank()) {
            Timber.i("STT[$label] partial: \"$txt\"")
            PerceptionBus.emit(PerceptionEvent.Transcript(txt, isFinal = false))
        }
    }

    override fun onResults(results: Bundle?) {
        listening = false
        val txt = firstResult(results) ?: ""
        Timber.i("STT[$label] RESULT final: \"$txt\" — disarmed")
        PerceptionBus.emit(PerceptionEvent.SttListening(armed = false))
        if (txt.isNotBlank()) {
            PerceptionBus.emit(PerceptionEvent.Transcript(txt, isFinal = true))
        }
        PerceptionBus.emit(PerceptionEvent.Status(label, "final"))
    }

    override fun onEvent(eventType: Int, params: Bundle?) {}

    private fun firstResult(b: Bundle?): String? =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun errorMessage(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "audio capture error"
        SpeechRecognizer.ERROR_CLIENT -> "client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "missing mic permission"
        SpeechRecognizer.ERROR_NETWORK -> "network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "no match"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech timeout"
        else -> "code=$code"
    }
}
