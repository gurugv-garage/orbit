package dev.orbit.dock.agent

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

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

    /**
     * An immutable read of the senses.
     * - [facePresent] = a face is visible RIGHT NOW (on-device ML Kit). Live.
     * - [identity]/[identityConf]/[identityAt] = the CACHED result of the last
     *   `recollect_face` (the station's pull recognition). The conversation
     *   "remembers" who it last saw; recollect refreshes it. May be stale if the
     *   person changed and nothing re-recollected — that's expected.
     */
    data class Facts(
        val facePresent: Boolean = false,
        val emotion: String? = null,
        val gaze: String? = null,
        val identity: String? = null,       // last recognized name (cached)
        val identityConf: Float = 0f,        // confidence of that match
        val identityAt: Long = 0L,           // when it was last refreshed (ms)
    )

    // StateFlow rather than AtomicReference: same atomic-swap semantics, but
    // the UI can observe it (e.g. the "who I see" badge) instead of polling.
    private val ref = MutableStateFlow(Facts())

    /** Observable senses for the UI. */
    val factsFlow: StateFlow<Facts> = ref.asStateFlow()

    val facts: Facts get() = ref.value

    /** Face appeared at normalised, mirror-corrected coords (see FaceSeen). */
    fun onFaceSeen(x: Float, y: Float) {
        ref.update { it.copy(facePresent = true, gaze = gazeLabel(x, y)) }
    }

    fun onFaceLost() {
        // Keep the last emotion (stale but harmless); drop presence + gaze.
        ref.update { it.copy(facePresent = false, gaze = null) }
    }

    fun onEmotion(kind: String) {
        ref.update { it.copy(emotion = kind.lowercase()) }
    }

    /**
     * Cache the result of a recollect (the station's pull recognition). Only a
     * RECOGNIZED name updates the cache — a "no one / unrecognized" result does NOT
     * wipe a previously-known person, so the conversation keeps "last I was talking
     * to X" even when you briefly look away. `faceVisibleNow` (facePresent) tells
     * the agent whether you're in view right now.
     */
    fun onIdentity(name: String?, confidence: Float = 0f) {
        if (name == null) return // keep the cached person; absence is faceVisibleNow's job
        ref.update { it.copy(identity = name, identityConf = confidence, identityAt = System.currentTimeMillis()) }
    }

    /** Explicit clear (forget_face / re-enroll), when we KNOW the cache is wrong. */
    fun clearIdentity() {
        ref.update { it.copy(identity = null, identityConf = 0f, identityAt = 0L) }
    }

    /**
     * One-line description for the per-turn prompt, weaving together what the dock
     * sees NOW (on-device face presence) and who it last recognized (the cache):
     *
     *   face now + known   → "You can see guru (toward your left); they appear happy."
     *   face now + unsure  → "You can see someone (you think it might be guru, but
     *                         you're not sure)."
     *   face now + unknown → "You can see someone you don't recognize yet."
     *   no face + cached   → "No one is in front of you right now; the last person
     *                         you saw was guru."
     *   no face + nothing  → null (omit).
     */
    fun describe(): String? {
        val f = ref.value
        if (f.facePresent) {
            val where = f.gaze?.let { " (toward your $it)" } ?: ""
            val mood = f.emotion?.let { "; they appear $it" } ?: ""
            val who = when {
                f.identity != null && f.identityConf >= LOW_CONF ->
                    "You can see ${f.identity}$where$mood."
                f.identity != null ->
                    "You can see someone$where$mood (you think it might be ${f.identity}, but you're not sure — recollect_face to check)."
                else ->
                    "You can see someone$where$mood — recollect_face to find out who."
            }
            return who
        }
        // No face in view: report the remembered person if we have one.
        return f.identity?.let { "No one is in front of you right now; the last person you saw was $it." }
    }

    /** Whether a face is currently visible (drives the "always recollect" rule). */
    val facePresent: Boolean get() = ref.value.facePresent

    private companion object {
        /** Below this match confidence, the agent should hedge / offer to confirm. */
        const val LOW_CONF = 0.45f

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
