package dev.orbit.dock.body.ui

/**
 * Process-singleton handle to the live BodyLinkComms instance, used by the
 * debug DevPanel BODY tab. DockScreen sets this when it constructs comms;
 * the panel reads it lazily so we don't have to thread the dependency
 * through DevBarHost.
 *
 * Debug-only. In release builds the DevPanel never renders so this is unused.
 */
object BodyTestController {
    @Volatile var comms: dev.orbit.dock.body.BodyLinkComms? = null
}
