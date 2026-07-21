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
 * as `FaceSeen`/`FaceLost` events arrive; read by [DockTools] when
 * it assembles the per-turn state context. Thread-safe via a single immutable
 * [Facts] swapped atomically (StateFlow so the UI can observe it too).
 *
 * MULTI-PERSON model: different people come and go mid-session, so identity is
 * a *sighting*, not a session constant:
 *  - [Facts.identityVerified] — the cached name came from a CONFIDENT station
 *    match during the current continuous sighting. The verdict is categorical
 *    (the station thresholds distances; we never re-threshold a raw score).
 *  - On [onFaceLost] the identity is DEMOTED (kept, but unverified): whoever
 *    sits down next may be someone else, so the prompt hedges until a fresh
 *    recollect confirms.
 *  - [Facts.people] — the last multi-face recollect result, so "who's here"
 *    stays grounded across turns when several people are in frame.
 *
 * Pure/Android-free so it's unit tested without a camera.
 */
class PerceptionSnapshot {

    /** One person from the last multi-face recollect (left-to-right). */
    data class SeenPerson(val name: String?, val tentative: String?, val side: String)

    /**
     * An immutable read of the senses.
     * - [facePresent] = a face is visible RIGHT NOW (on-device ML Kit). Live.
     * - [identity] = the last recognized (or tentatively guessed) name.
     * - [identityVerified] = the station's verdict for that name was CONFIDENT
     *   (vs a tentative guess). This records what the match WAS — it is not
     *   erased by the person stepping out of frame ([identityAt] + [sightingContinuous]
     *   carry the "is that still current" question).
     * - [identityAt] = when that verdict landed (recency: an identity from the
     *   pre-turn recognition seconds ago is authoritative for "who am I" even
     *   if the asker has just stepped out of view).
     * - [sightingContinuous] = the face has been continuously in frame since
     *   [identityAt]. False after a FaceLost: whoever appears next may be a
     *   different person, so the PROMPT hedges until a fresh recollect.
     * - [people]/[peopleAt] = last multi-face recollect (several in frame).
     */
    data class Facts(
        val facePresent: Boolean = false,
        val gaze: String? = null,
        val identity: String? = null,
        val identityVerified: Boolean = false,
        val identityAt: Long = 0L,
        val sightingContinuous: Boolean = false,
        val people: List<SeenPerson> = emptyList(),
        val peopleAt: Long = 0L,
    )

    private val ref = MutableStateFlow(Facts())

    /** Observable senses for the UI. */
    val factsFlow: StateFlow<Facts> = ref.asStateFlow()

    val facts: Facts get() = ref.value

    /** Face appeared at normalised, mirror-corrected coords (see FaceSeen). */
    fun onFaceSeen(x: Float, y: Float) {
        ref.update { it.copy(facePresent = true, gaze = gazeLabel(x, y)) }
    }

    /**
     * Face left the frame. Presence + gaze drop and the sighting's CONTINUITY
     * breaks: the next face to appear may be a different person, so the prompt
     * hedges ("possibly X — recollect to check") instead of confidently naming
     * whoever was here last. The match VERDICT itself ([Facts.identityVerified])
     * is not erased — "Guru was confidently recognized 5s ago" stays true and
     * still answers "who am I" for the person who just asked and stepped away.
     */
    fun onFaceLost() {
        ref.update { it.copy(facePresent = false, gaze = null, sightingContinuous = false) }
    }

    /**
     * Cache a recognition result. `verified=true` only for the station's
     * CONFIDENT verdict; a tentative guess caches unverified (the prompt
     * hedges, recollect/confirm resolves it). A null name never wipes the
     * cached person — absence is [facePresent]'s job. A fresh result starts a
     * new continuous sighting (the photo proves who was in frame just now).
     * `at` is a test seam; production uses the wall clock.
     */
    fun onIdentity(name: String?, verified: Boolean = false, at: Long = System.currentTimeMillis()) {
        if (name == null) return
        ref.update {
            it.copy(identity = name, identityVerified = verified, identityAt = at, sightingContinuous = true)
        }
    }

    /** The last multi-face recollect: who's in frame, left-to-right. */
    fun onPeople(people: List<SeenPerson>) {
        ref.update { it.copy(people = people, peopleAt = System.currentTimeMillis()) }
    }

    /**
     * A fresh recognition found a face that matched NOBODY (not even
     * tentatively): the person in frame now is a stranger, so the cached
     * identity's recency is void — "who am I" must not answer with the
     * previous person's name. The name itself is kept only as cold history
     * ("the last person I spoke with was X"). This is what makes the generous
     * ask-time freshness window safe in a multi-person room.
     */
    fun onUnrecognized() {
        ref.update { it.copy(sightingContinuous = false, identityAt = 0L) }
    }

    /** Explicit clear (forget_face / re-enroll), when we KNOW the cache is wrong. */
    fun clearIdentity() {
        ref.update { it.copy(identity = null, identityVerified = false, identityAt = 0L) }
    }

    /**
     * One-line description for the per-turn prompt, weaving together what the
     * dock sees NOW (on-device presence) and who it knows (the station cache):
     *
     *   several people (fresh)   → "You can see N people: Guru on the left, …"
     *   face + verified name     → "You can see guru (toward your left); …"
     *   face + unverified name   → "You can see someone — possibly guru, but
     *                               people come and go; recollect_face to check."
     *   face + unknown           → "You can see someone you don't recognize yet."
     *   no face + cached name    → "No one is in front of you right now; the
     *                               last person you saw was guru."
     *   no face + nothing        → null (omit).
     */
    fun describe(now: Long = System.currentTimeMillis()): String? {
        val f = ref.value
        if (f.facePresent) {
            // Multiple people seen recently → ground the crowd, not one name.
            if (f.people.size > 1 && now - f.peopleAt <= PEOPLE_FRESH_MS) {
                val who = f.people.joinToString(", ") { p ->
                    when {
                        p.name != null -> "${p.name} on the ${p.side}"
                        p.tentative != null -> "possibly ${p.tentative} on the ${p.side}"
                        else -> "someone unknown on the ${p.side}"
                    }
                }
                return "You can see ${f.people.size} people: $who. (recollect_face to re-check.)"
            }
            val where = f.gaze?.let { " (toward your $it)" } ?: ""
            return when {
                // Name confidently only while the verified sighting is
                // UNBROKEN — after a face-lost gap, whoever is in frame now
                // may be someone else (people come and go).
                f.identity != null && f.identityVerified && f.sightingContinuous ->
                    "You can see ${f.identity}$where."
                f.identity != null ->
                    "You can see someone$where — possibly ${f.identity}, but people come and go; recollect_face to check who it is."
                else ->
                    "You can see someone$where — recollect_face to find out who."
            }
        }
        // No face in view: report the remembered person if we have one.
        return f.identity?.let { "No one is in front of you right now; the last person you saw was $it." }
    }

    /** Whether a face is currently visible (drives the "always recollect" rule). */
    val facePresent: Boolean get() = ref.value.facePresent

    private companion object {
        /** How long a multi-person sighting stays trusted for prompt grounding. */
        const val PEOPLE_FRESH_MS = 120_000L

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
