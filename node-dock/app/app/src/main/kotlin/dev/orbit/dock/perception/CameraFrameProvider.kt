package dev.orbit.dock.perception

/**
 * Supplies the most recent camera frame as a base64-encoded JPEG, for attaching
 * to a vision LLM turn (Ollama `/api/chat` `images:[...]`). [FaceTracker] is the
 * real implementation (it already decodes a bitmap per frame); tests/headless
 * builds can supply a fake or null.
 *
 * `latestJpegBase64()` returns null when no frame is available yet (camera off,
 * permission denied, or no frame captured), so the agent simply sends a
 * text-only turn in that case.
 */
interface CameraFrameProvider {
    /** Latest frame as base64 JPEG, or null if none is available. */
    fun latestJpegBase64(): String?

    /**
     * Debug-only handle to the live frame source, so the adb test harness can
     * dump the exact frame the dock would send. Set by the UI in debug builds;
     * null in release. (Mirrors ToolsTestController.)
     */
    companion object {
        @Volatile var debugInstance: CameraFrameProvider? = null
    }
}
