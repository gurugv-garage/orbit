package dev.orbit.dock.ui.face

/**
 * Decides when a face in the camera counts as a PERSON SETTLING IN FRONT OF THE
 * DOCK — a deliberate "I'm here" — versus someone just walking past, lingering in
 * the far background, or flickering in and out at the frame edge. It turns the raw,
 * twitchy per-frame [PerceptionEvent.FaceSeen]/[FaceLost] stream into two clean
 * edges: [Edge.ARRIVE] (open a listen window) and [Edge.LEAVE] (release it).
 *
 * Why this exists: the raw face events fire the instant ANY face ≥ the detector's
 * min size appears anywhere in frame, and clear ~0.5 s after it's gone. Without
 * gating, walking around / moving in-and-out / a distant passer-by made the dock's
 * presence-listening flap on-off-on-off. We want "look for a face that's actually
 * here," not motion through the frame.
 *
 * Three gates, all tunable constants ([Cfg]):
 *  1. NEAR     — the face must be big enough (close), filtering distant people.
 *  2. CENTERED — the face must be roughly in the middle, filtering edge/walk-by.
 *  3. SUSTAINED — it must stay qualifying continuously for a debounce window before
 *                 ARRIVE fires (a glance-through never qualifies).
 * Leaving is also debounced (a brief drop-out / look-away doesn't end presence).
 *
 * Pure + deterministic: the caller passes `now` (ms) and the face geometry; the gate
 * holds only timers. The post-leave COOLDOWN (so you can't re-trigger by pacing in
 * and out) lives on the STATION side (conversation-state), not here — this gate is
 * about "is a person settled in frame," the station owns the conversation cadence.
 */
class PresenceGate {

    enum class Edge { NONE, ARRIVE, LEAVE }

    /** Tunable presence thresholds. Constants (documented in
     *  docs/conversation-ux-flow.md → camera presence) so they're easy to tune. */
    object Cfg {
        /** Face must occupy at least this fraction of the frame WIDTH to count as
         *  "near" (close enough to be addressing the dock, not a distant passer-by).
         *  ML Kit's minFaceSize is 0.15; a settled user at desk distance is larger. */
        const val NEAR_MIN_SIZE = 0.22f
        /** Max |x| and |y| (NDC, center = 0, edges = ±1) to count as "centered."
         *  A face out near the frame edge is walking through, not facing the dock. */
        const val CENTER_MAX_X = 0.55f
        const val CENTER_MAX_Y = 0.6f
        /** A qualifying (near+centered) face must persist this long before ARRIVE
         *  fires — debounces flicker and walk-throughs into a real "settled" signal. */
        const val SUSTAIN_MS = 1_500L
        /** After the face stops qualifying, wait this long before declaring LEAVE —
         *  a brief look-away / detector drop-out doesn't end presence. */
        const val LEAVE_GRACE_MS = 2_000L
    }

    // null = not currently "present" (arrived). Tracks the edge state we last emitted.
    private var present = false
    // When the face FIRST started qualifying in the current qualifying run (0 = none).
    private var qualifyingSince = 0L
    // When the face last STOPPED qualifying while we were present (0 = still qualifying).
    private var lostQualifyingAt = 0L

    /** Feed one detected face. Returns the edge this frame produced (usually NONE). */
    fun onFace(x: Float, y: Float, size: Float, now: Long): Edge {
        val qualifies = size >= Cfg.NEAR_MIN_SIZE &&
            kotlin.math.abs(x) <= Cfg.CENTER_MAX_X &&
            kotlin.math.abs(y) <= Cfg.CENTER_MAX_Y

        if (qualifies) {
            lostQualifyingAt = 0L
            if (!present) {
                if (qualifyingSince == 0L) qualifyingSince = now
                if (now - qualifyingSince >= Cfg.SUSTAIN_MS) {
                    present = true
                    return Edge.ARRIVE
                }
            }
        } else {
            // Face present but no longer qualifying (moved away / off-center / far).
            qualifyingSince = 0L
            if (present) {
                if (lostQualifyingAt == 0L) lostQualifyingAt = now
                if (now - lostQualifyingAt >= Cfg.LEAVE_GRACE_MS) {
                    present = false
                    lostQualifyingAt = 0L
                    return Edge.LEAVE
                }
            }
        }
        return Edge.NONE
    }

    /** No face detected at all this evaluation (the detector reported empty). Treated
     *  like "not qualifying" — debounced into a LEAVE after the grace window. */
    fun onNoFace(now: Long): Edge {
        qualifyingSince = 0L
        if (present) {
            if (lostQualifyingAt == 0L) lostQualifyingAt = now
            if (now - lostQualifyingAt >= Cfg.LEAVE_GRACE_MS) {
                present = false
                lostQualifyingAt = 0L
                return Edge.LEAVE
            }
        }
        return Edge.NONE
    }

    /** True while we consider a person settled in frame (between ARRIVE and LEAVE). */
    fun isPresent(): Boolean = present
}
