package dev.orbit.dock.ui.face

/** Coarse state of the dock face. See dock README §3 for transitions. */
enum class FaceState {
    Idle,        // breathing, blinking, drifting
    Engaged,     // wake fired; pupils dilate
    Listening,   // user speech in progress
    Speaking,    // bot TTS in progress
    Illustrating // showing content; face shrinks to corner
}

/**
 * Who is currently producing audio. Mirrors the bottom-status indicator.
 */
enum class Speaker { Silent, User, Bot, Muted }

/**
 * Gaze direction in eye-local space. (0,0) = center, (-1..1, -1..1) = corners.
 */
data class GazeOffset(val x: Float = 0f, val y: Float = 0f)

/** Coarse face expression. Drives subtle facial shape changes. */
enum class FaceExpression {
    Neutral, Happy, Curious, Concerned, Surprised, Sleepy,
    Wink, Sad, Excited, Angry, Love,
}
