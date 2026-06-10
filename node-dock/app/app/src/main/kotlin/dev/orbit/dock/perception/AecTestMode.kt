package dev.orbit.dock.perception

/**
 * Process-wide flag that disables the perception pipeline's TTS echo gate, so
 * STT stays armed *through* the dock's own speech. Used only by [AecSelfTest] to
 * measure whether acoustic echo cancellation stops the dock from transcribing
 * itself — the echo gate (which normally stops STT during TTS) would otherwise
 * mask that. Off in all normal operation.
 */
object AecTestMode {
    @Volatile var enabled = false
}
