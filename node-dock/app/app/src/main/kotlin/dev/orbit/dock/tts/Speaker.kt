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
}
