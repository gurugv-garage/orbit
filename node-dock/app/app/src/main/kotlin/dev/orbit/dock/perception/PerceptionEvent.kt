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

    /** Debug-only: run the acoustic echo-cancellation self-test (AecSelfTest). */
    data object RunAecTest : PerceptionEvent()

    /**
     * The user spoke while the dock was talking → barge-in. Detected by the
     * pipeline (VAD active during TTS, on echo-cancelled audio so it isn't the
     * dock hearing itself). The UI handles it exactly like a tap-during-speech:
     * stop TTS + the agent turn, then start a fresh listening session.
     */
    data object BargeIn : PerceptionEvent()

    /**
     * Hold (true) / release (false) TTS playback mid-reply — the barge-in
     * "polite pause". Unlike [BargeIn] (hard cancel), the turn and the speaking
     * signal stay up while held; release continues playback where it stopped.
     * Emitted by the debug PAUSETTS/RESUMETTS broadcasts and (next) the
     * loud-audio-during-TTS detector.
     */
    data class TtsHold(val hold: Boolean) : PerceptionEvent()

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
     * RICH per-frame face detail from the on-device MLKit detector — everything the
     * single detection pass already computes that [FaceSeen] (gaze/UI) throws away.
     * Emitted alongside FaceSeen on each ~1 Hz analysis tick. Forwarded to the station
     * as the `perceive` stream (the fast face source for faceFollow + the perception
     * pipeline) by PerceiveForwarder; phone UI does NOT consume this (it uses FaceSeen).
     *
     * Coordinates match FaceSeen: NDC, mirror-corrected, x∈[-1,+1] (right+), y∈[-1,+1]
     * (down+). Angles are MLKit head Euler degrees. `landmarks` are up to 11 named
     * points in the same NDC space. All optional fields are null when MLKit didn't
     * provide them (e.g. probabilities can be absent).
     */
    data class PerceiveFrame(
        val faces: List<FaceDetail>,
        /** CameraX current zoom FRAMING (read-only this build). */
        val zoomRatio: Float,
        val zoomMin: Float,
        val zoomMax: Float,
    ) : PerceptionEvent() {
        data class FaceDetail(
            val x: Float, val y: Float, val size: Float,        // NDC center + width frac
            val bl: Float, val bt: Float, val br: Float, val bb: Float, // NDC bbox
            val yaw: Float, val pitch: Float, val roll: Float,  // MLKit head Euler (deg)
            val trackingId: Int?,                                // stable across frames
            val smile: Float?, val leftEyeOpen: Float?, val rightEyeOpen: Float?,
            val landmarks: List<Landmark>,                       // up to 11 named points (NDC)
        )
        data class Landmark(val type: String, val x: Float, val y: Float)
    }

    /**
     * On-device HAND gesture status from the camera (MediaPipe Gesture
     * Recognizer; see PalmDetector). `gesture` is the recognizer's current label
     * ("Open_Palm", "Closed_Fist", "None", …) or null when no hand is in frame;
     * `score` is its confidence. `palm` is true on the frame an OPEN PALM is
     * detected (rising edge). Drives the on-screen status overlay AND the palm-to-
     * address/interrupt trigger in DockScreen (mirror of a tap).
     */
    data class HandGesture(
        val gesture: String?,
        val score: Float,
        val palm: Boolean,
    ) : PerceptionEvent()

    /**
     * Identity recognized by the STATION's stream processing (face/voice fused),
     * not the on-device camera. Lets the agent address the user by name. `name`
     * null = a person is present but not recognized. Arrives over the station's
     * `perception` topic (see StationLink.onPerceptionFrame).
     */
    data class UserIdentified(val name: String?, val confidence: Float) : PerceptionEvent()

    /**
     * Coarse presence from the station's processing (a dock is streaming / a face
     * is visible server-side), distinct from the on-device [FaceSeen]/[FaceLost].
     */
    data class RemotePresence(val present: Boolean) : PerceptionEvent()

    /** Internal — perception subsystem state transitions. */
    data class Status(val source: String, val message: String) : PerceptionEvent()

    /** Errors so the UI can show a sensible state instead of failing silently. */
    data class Error(val source: String, val cause: Throwable) : PerceptionEvent()
}
