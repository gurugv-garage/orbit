package dev.orbit.dock.agent

import java.util.concurrent.atomic.AtomicReference

/**
 * The dock's live "senses" at the moment a turn starts — what the camera sees
 * right now — so the LLM can answer "what are you looking at?" / "how do I
 * seem?" from reality instead of guessing.
 *
 * Updated by the perception layer ([dev.orbit.dock.ui.face.PerceptionWiring])
 * as `FaceSeen`/`FaceLost`/`UserEmotion` events arrive; read by [DockTools] when
 * it assembles the per-turn state context. Thread-safe (events fire on the
 * perception coroutine; the read happens on the agent coroutine) via a single
 * immutable [Facts] swapped atomically.
 *
 * Pure/Android-free so it's unit tested without a camera.
 */
class PerceptionSnapshot {

    /** An immutable read of the senses. `null` emotion = not yet classified. */
    data class Facts(
        val facePresent: Boolean = false,
        val emotion: String? = null,        // "happy", "sad", … (lowercased Kind)
        val gaze: String? = null,           // "left" | "right" | "center" | "up" | "down"
        val identity: String? = null,       // recognized name from the station, or null
    )

    private val ref = AtomicReference(Facts())

    val facts: Facts get() = ref.get()

    /** Face appeared at normalised, mirror-corrected coords (see FaceSeen). */
    fun onFaceSeen(x: Float, y: Float) {
        ref.updateAndGet { it.copy(facePresent = true, gaze = gazeLabel(x, y)) }
    }

    fun onFaceLost() {
        // Keep the last emotion (stale but harmless); drop presence + gaze.
        ref.updateAndGet { it.copy(facePresent = false, gaze = null) }
    }

    fun onEmotion(kind: String) {
        ref.updateAndGet { it.copy(emotion = kind.lowercase()) }
    }

    /** Identity recognized by the station (face/voice). null name = unrecognized. */
    fun onIdentity(name: String?) {
        ref.updateAndGet { it.copy(identity = name) }
    }

    /** Station-sourced coarse presence (distinct from on-device face presence). */
    fun onRemotePresence(present: Boolean) {
        // If the station says no one's there, drop a stale identity.
        ref.updateAndGet { if (present) it else it.copy(identity = null) }
    }

    /**
     * One-line description for the prompt, or null when the dock sees nothing
     * (so [DockTools] can omit it rather than say "no face", which reads oddly).
     *
     * Examples:
     *   "You can see the user (looking to your left); they appear happy."
     *   "You can see the user; they appear neutral."
     *   null  (no face in view)
     */
    fun describe(): String? {
        val f = ref.get()
        if (!f.facePresent) return null
        // "the user" → "guru" when the station has recognized them.
        val who = f.identity ?: "the user"
        val where = f.gaze?.let { " (they are toward your $it)" } ?: ""
        val mood = f.emotion?.let { "; they appear $it" } ?: ""
        return "You can see $who$where$mood."
    }

    private companion object {
        /** Map mirror-corrected NDC coords to a coarse direction word. Center
         *  band is generous so small movements don't read as "looking away". */
        fun gazeLabel(x: Float, y: Float): String = when {
            x <= -0.4f -> "left"
            x >= 0.4f -> "right"
            y <= -0.4f -> "top"
            y >= 0.4f -> "bottom"
            else -> "center"
        }
    }
}
