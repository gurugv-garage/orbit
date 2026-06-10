package dev.orbit.dock.tts

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import dev.orbit.dock.ui.face.FaceController
import timber.log.Timber
import java.util.Locale
import java.util.UUID
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
    private val activeUtterances = mutableSetOf<String>()

    private val tts: TextToSpeech = TextToSpeech(appCtx) { status ->
        if (status == TextToSpeech.SUCCESS) {
            Timber.d("TTS init success")
            // Try US English first; falls back if unavailable.
            val result = tts?.setLanguage(Locale.US) ?: TextToSpeech.LANG_NOT_SUPPORTED
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Timber.w("TTS lang not supported (result=$result) — using default")
            }
            // Slight character: speak slightly faster than default to feel responsive
            tts?.setSpeechRate(1.0f)
            tts?.setPitch(1.05f)
            // Keep TTS on the normal media/assistant output so it's clearly
            // audible on the speaker. The platform AEC on the VOICE_COMMUNICATION
            // *capture* path cancels against the device's speaker output mix, so
            // it still subtracts our TTS from the mic without us having to hijack
            // playback routing (USAGE_VOICE_COMMUNICATION can route to earpiece /
            // go silent outside a call). Capture-side AEC, audible playback.
            tts?.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
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
                Timber.v("TTS start: $utteranceId")
                face.speak()
                onSpeakingChanged(true)
            }

            override fun onDone(utteranceId: String?) {
                Timber.v("TTS done: $utteranceId")
                finishUtterance(utteranceId)
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
        })
    }

    /**
     * Shared cleanup for an utterance ending (success OR error). Removes it
     * from the active set; when nothing is left to speak, silences the face
     * and signals speaking=false so the wake gate reopens. Called from both
     * onDone and onError — an error path that skips this is what stuck the
     * face in Speaking.
     */
    private fun finishUtterance(utteranceId: String?) {
        synchronized(activeUtterances) {
            if (utteranceId != null) activeUtterances.remove(utteranceId)
            if (activeUtterances.isEmpty() && pending.isEmpty()) {
                face.silence()
                onSpeakingChanged(false)
            }
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
            synchronized(activeUtterances) { activeUtterances.clear() }
            synchronized(pending) { pending.clear() }
        } catch (t: Throwable) {
            Timber.w(t, "TTS stop failed")
        }
    }

    fun shutdown() {
        try {
            tts.stop()
            tts.shutdown()
        } catch (_: Throwable) {
        }
    }

    private fun flushPending() {
        synchronized(pending) {
            for (chunk in pending) speakNow(chunk)
            pending.clear()
        }
    }

    private fun speakNow(text: String) {
        val id = UUID.randomUUID().toString()
        synchronized(activeUtterances) { activeUtterances.add(id) }
        val params = Bundle().apply {
            putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id)
        }
        tts.speak(text, TextToSpeech.QUEUE_ADD, params, id)
    }
}
