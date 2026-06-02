package dev.orbit.dock.perception

/**
 * Pure decision state machine for "continuous conversation".
 *
 * Goal: after the dock finishes speaking its reply to a VOICE-initiated turn,
 * re-arm the mic exactly once so the user can keep talking without tapping.
 * A turn that wasn't voice-initiated (the dock spoke on its own, or there was
 * no active listening session) must not arm the mic.
 *
 * Kept free of Android/coroutine deps so it is fully unit tested
 * ([dev.orbit.dock.perception.AutoRelistenTest]); [PerceptionPipeline] feeds
 * it events and emits a tap-listen WakeWord when [onSpeakingChanged] returns
 * true on the speaking→false edge.
 *
 * Definition of "voice-initiated": a final transcript arrived while a
 * listening session was active. SAY/debug injection rides the same session
 * path, so it counts too — which is the desired behaviour.
 */
class AutoRelisten {

    /** A listening session is currently open (tap-listen / prior re-arm). */
    private var sessionActive = false

    /** This turn was started by a voice transcript and hasn't re-armed yet. */
    private var voiceTurnPending = false

    /** A listening session began (user tapped, or we auto-re-armed). Any stale
     *  pending re-arm from a previous turn is dropped — the new session owns
     *  the flow now. */
    fun onSessionStarted() {
        sessionActive = true
        voiceTurnPending = false
    }

    /** A final transcript was produced. Only counts as a voice turn if a
     *  session was actually active when it arrived. */
    fun onVoiceTranscript() {
        if (sessionActive) {
            voiceTurnPending = true
        }
        sessionActive = false
    }

    /** The session ended without a transcript (user said nothing). No re-arm. */
    fun onSessionEndedEmpty() {
        sessionActive = false
        voiceTurnPending = false
    }

    /** The user cancelled (tap-stop / barge-in). Drop any pending re-arm. */
    fun onCancelled() {
        sessionActive = false
        voiceTurnPending = false
    }

    /**
     * Dock speaking-state changed (driven by TTS). Returns true exactly when
     * the speaking→false edge should trigger a single mic re-arm — i.e. a
     * voice turn was pending. Consumes the pending flag so it fires once.
     */
    fun onSpeakingChanged(active: Boolean): Boolean {
        if (active) return false
        if (!voiceTurnPending) return false
        voiceTurnPending = false
        return true
    }
}
