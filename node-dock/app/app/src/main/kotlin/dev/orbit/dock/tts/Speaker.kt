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
     * Hold speech mid-reply without dropping anything (the barge-in "polite
     * pause"): the queue and the speaking signal stay up; [resume] continues
     * where playback left off. Default no-ops keep fakes unaffected.
     */
    fun pause() {}
    fun resume() {}

    /**
     * A turn opened/closed: between these, more sentences may still stream in,
     * so a momentarily-empty TTS queue must NOT be treated as "stopped
     * speaking" (see [SpeakingEdgeGate]). Default no-ops keep test fakes and
     * simple speakers unaffected.
     */
    fun onTurnBegin() {}
    fun onTurnEnd() {}
}
