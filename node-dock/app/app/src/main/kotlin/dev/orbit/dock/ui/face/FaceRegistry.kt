package dev.orbit.dock.ui.face

/**
 * All faces the dock can wear. To add a face: write one object implementing
 * [Face] and add it to [faces]. Keep the ids in sync with the station's
 * FACE_STYLES enum (brain `set_face_style` tool + `faceStyle` config key).
 */
object FaceRegistry {
    val faces: List<Face> = listOf(
        AuroraFace,
        PuppyFace,
        VaderFace,
        RobotFace,
        GhostFace,
        OwlFace,
        DragonFace,
    )

    val default: Face = AuroraFace

    /** Resolve a face id to a [Face]; unknown/null falls back to [default]. */
    fun byId(id: String?): Face = faces.firstOrNull { it.id == id } ?: default

    /** Whether [id] names a known face. */
    fun isKnown(id: String?): Boolean = id != null && faces.any { it.id == id }
}
