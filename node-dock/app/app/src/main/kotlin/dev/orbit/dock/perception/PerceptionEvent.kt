package dev.orbit.dock.perception

/**
 * Events produced by the perception layer (mic, camera, touch, sensors).
 *
 * The agent + UI subscribe to a single event stream so M2's mic flow,
 * M3's STT, M5's gaze, and any debug-only producers are interchangeable.
 */
sealed class PerceptionEvent {

    /** Live audio level [0..1] — drives the VAD bar. Emitted at ~10 Hz. */
    data class AudioLevel(val level: Float) : PerceptionEvent()

    /** VAD state changes. */
    data class VoiceActivity(val active: Boolean, val probability: Float) : PerceptionEvent()

    /** Wake-word fired. `label` identifies which one ("hey jarvis", "alexa", …). */
    data class WakeWord(val label: String, val score: Float = 1f) : PerceptionEvent()

    /** Request to end an in-progress listening session early (tap-to-stop). */
    data object StopListening : PerceptionEvent()

    /** The dock started/stopped speaking (TTS). Drives the STT echo gate:
     *  STT pauses while speaking so the mic doesn't hear the dock itself. */
    data class Speaking(val active: Boolean) : PerceptionEvent()

    /**
     * The real, moment-to-moment STT microphone state. Emitted the instant
     * SpeechRecognizer actually arms (true → device beeps "ready") and
     * disarms (false → beep down / ended). The UI binds "listening" text to
     * THIS so the on-screen state stays in sync with the audible beeps,
     * instead of showing a static "listening" across re-arm cycles.
     */
    data class SttListening(val armed: Boolean) : PerceptionEvent()

    /** A transcribed user utterance (M3). */
    data class Transcript(val text: String, val isFinal: Boolean) : PerceptionEvent()

    /**
     * Face seen in camera. Coordinates are normalised, mirror-corrected
     * for the front cam, in the range [-1..+1]:
     *   x: -1 = user's left edge of frame, +1 = user's right edge
     *   y: -1 = top of frame, +1 = bottom
     * `size` = bounding-box width as a fraction of frame width (0..1).
     * Emit `Lost` when no face is detected for a beat.
     */
    data class FaceSeen(
        val x: Float,
        val y: Float,
        val size: Float,
    ) : PerceptionEvent()

    data object FaceLost : PerceptionEvent()

    /**
     * The dock's read of the user's emotional state from the camera. Drives
     * passive emotion mirroring while the dock is watching/listening so the
     * face reacts to the user even between LLM turns.
     */
    data class UserEmotion(val kind: Kind, val confidence: Float) : PerceptionEvent() {
        enum class Kind { Neutral, Happy, Sad, Surprised, Sleepy, Angry }
    }

    /** Internal — perception subsystem state transitions. */
    data class Status(val source: String, val message: String) : PerceptionEvent()

    /** Errors so the UI can show a sensible state instead of failing silently. */
    data class Error(val source: String, val cause: Throwable) : PerceptionEvent()
}
