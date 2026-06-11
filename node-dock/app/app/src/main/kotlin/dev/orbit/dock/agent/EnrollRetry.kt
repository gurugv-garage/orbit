package dev.orbit.dock.agent

/**
 * Decision machine for face-enrollment results (`remember_face`/station
 * `enroll-result`). The voice flow is optimistic ("Okay, I'll remember you as
 * Guru") — before this, a station-side failure ("no face detected") was only
 * logged, so the dock confirmed saves that never happened and recognition
 * later looked randomly broken.
 *
 * Policy: one silent retry with a FRESH frame (the first frame may have been
 * stale/blurred); if that fails too, speak a correction so the user knows to
 * try again. Pure → unit-tested ([EnrollRetryTest]).
 */
class EnrollRetry(private val maxAttempts: Int = 2) {

    sealed interface Action {
        /** Result didn't belong to an in-flight enrollment — ignore. */
        data object None : Action
        /** Enrollment confirmed server-side — nothing to do. */
        data object Done : Action
        /** Re-send the enroll request with a fresh photo. */
        data class Retry(val name: String, val attempt: Int) : Action
        /** Out of attempts — speak [line] so the user knows it didn't save. */
        data class GiveUp(val name: String, val line: String) : Action
    }

    private data class InFlight(val name: String, val attempt: Int)

    @Volatile private var inFlight: InFlight? = null

    /** remember_face fired an enroll-request for [name]. */
    fun begin(name: String) {
        inFlight = InFlight(name.trim(), 1)
    }

    /** A station `enroll-result` arrived. */
    fun onResult(name: String?, ok: Boolean): Action {
        val s = inFlight ?: return Action.None
        if (name != null && !name.equals(s.name, ignoreCase = true)) return Action.None
        if (ok) {
            inFlight = null
            return Action.Done
        }
        if (s.attempt < maxAttempts) {
            inFlight = InFlight(s.name, s.attempt + 1)
            return Action.Retry(s.name, s.attempt + 1)
        }
        inFlight = null
        return Action.GiveUp(
            s.name,
            "Hmm, I couldn't get a clear look at your face, so I haven't saved it yet. " +
                "Face me straight on and tell me your name again?",
        )
    }
}
