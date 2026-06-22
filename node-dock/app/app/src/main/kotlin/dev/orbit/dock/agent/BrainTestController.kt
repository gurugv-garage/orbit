package dev.orbit.dock.agent

/**
 * Process-singleton handle to the live [RemoteBrain], used by the debug
 * DebugTestReceiver to drive brain-facing actions over `adb shell am broadcast`
 * without a real on-screen gesture — e.g. flagging FEEDBACK on the session
 * (feedback-flow) to exercise the capture path end-to-end.
 *
 * DockScreen sets this when it constructs the brain. Debug-only in practice;
 * the setter is cheap and harmless in release.
 */
object BrainTestController {
    @Volatile var brain: RemoteBrain? = null
}
