package dev.orbit.dock.agent

/**
 * Process-singleton handle to the live [DockTools], used by the debug
 * DebugTestReceiver to invoke a tool directly (e.g. set_face) without going
 * through a full LLM turn — so the face/body/gesture path is testable over
 * `adb shell am broadcast`.
 *
 * DockScreen sets this when it constructs tools. Debug-only in practice; the
 * setter is cheap and harmless in release.
 */
object ToolsTestController {
    @Volatile var tools: DockTools? = null
}
