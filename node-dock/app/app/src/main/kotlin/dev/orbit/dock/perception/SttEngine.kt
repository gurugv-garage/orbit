package dev.orbit.dock.perception

import java.io.Closeable

/**
 * Speech-to-text producer interface.
 *
 * Implementations push `PerceptionEvent.Transcript` events onto the
 * [PerceptionBus]. Lifecycle: `start()` begins capturing, `stop()` ends
 * the current capture and emits the final transcript (if any). Engines
 * are one-shot: call `start()` again for the next utterance.
 *
 * Implementations:
 *   - [AndroidSpeechRecognizerStt] — Google cloud STT, free, network-bound
 *   - WhisperCppStt — on-device whisper.cpp (M3.1, TODO)
 *   - Dev text-input bar — synthesizes Transcript events from typed text
 */
interface SttEngine : Closeable {
    /** Engine label for logs / UI ("speech-recognizer", "whisper.cpp", "dev-typed"). */
    val label: String

    /** Begin capturing the next utterance. */
    fun start()

    /** Stop the current capture; finalize and emit a Transcript if any. */
    fun stop()
}
