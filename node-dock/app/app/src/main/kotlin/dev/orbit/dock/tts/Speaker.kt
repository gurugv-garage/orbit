package dev.orbit.dock.tts

/**
 * The minimal speech surface the agent/tools depend on. [DockTts] is the
 * Android implementation; tests use a fake that records spoken text without
 * touching the platform TextToSpeech engine.
 */
interface Speaker {
    /** Queue a sentence to be spoken aloud. */
    fun enqueueSentence(text: String)

    /** Stop speaking immediately and drop anything queued. */
    fun stop()

    /**
     * A turn opened/closed: between these, more sentences may still stream in,
     * so a momentarily-empty TTS queue must NOT be treated as "stopped
     * speaking" (see [SpeakingEdgeGate]). Default no-ops keep test fakes and
     * simple speakers unaffected.
     */
    fun onTurnBegin() {}
    fun onTurnEnd() {}
}
