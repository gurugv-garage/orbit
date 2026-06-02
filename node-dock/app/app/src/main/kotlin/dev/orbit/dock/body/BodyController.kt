package dev.orbit.dock.body

import kotlinx.coroutines.flow.StateFlow

/**
 * The minimal body surface [dev.orbit.dock.agent.DockTools] depends on to drive
 * movement. [BodyLinkComms] is the real (WebSocket) implementation; tests use a
 * fake that records `setState` calls + their timing without a socket or servos.
 *
 * Kept deliberately small — just what the movement sequencer touches — so the
 * complicated part (validation, timed multi-step sequences, preemption) is
 * unit-testable against a mock body when no hardware is connected.
 */
interface BodyController {
    /** Whether a body is connected right now. Gates whether moves are sent. */
    val connected: StateFlow<Boolean>

    /** Catalog validated against the connected body's profile (states + travel
     *  times the body actually supports). Used to resolve `(part, state)`. */
    val validatedCatalog: BodyStateCatalog

    /** Resolve `(part, stateName)` via the catalog and command the body to move
     *  there. A no-op (logged) if the state is unknown or not connected. */
    suspend fun setState(part: String, stateName: String)
}
