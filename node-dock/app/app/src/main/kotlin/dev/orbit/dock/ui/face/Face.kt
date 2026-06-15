package dev.orbit.dock.ui.face

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import dev.orbit.dock.ui.theme.DockPalette
import java.util.Locale

/**
 * A pluggable dock face. Each face is a self-contained renderer that honours the
 * SAME behaviour contract the brain drives — the 11 [FaceExpression] moods, the
 * coarse [FaceState] (Idle/Engaged/Listening/Speaking/Illustrating), privacy,
 * gaze, etc. — so faces are fully interchangeable and the brain never needs to
 * know which one is showing.
 *
 * Adding a new face = write one object implementing [Face] and add it to
 * [FaceRegistry.faces]. That single list edit is the entire authoring surface.
 *
 * Most faces lean on the shared kit in `FacePrimitives.kt` + the animation
 * engine [rememberFaceFrame] (blink/breath/micro-saccade/expression tween), so a
 * new face is usually a few hundred lines of drawing, not a full rewrite. A face
 * is free to ignore the kit and draw entirely custom (see RobotFace).
 */
interface Face {
    /** Stable key — used by the `set_face_style` tool, the `faceStyle` config
     *  key, and SharedPreferences. Must match the station's FACE_STYLES enum. */
    val id: String

    /** Human-readable name for the dev picker / logs. */
    val label: String

    /** Voice applied to on-device TTS while this face is active. */
    val voice: VoiceProfile

    /** Colours this face draws with. Drives [currentEyeColor] + screen bg. */
    val palette: FacePalette

    @Composable
    fun Render(
        modifier: Modifier,
        state: FaceState,
        gaze: GazeOffset,
        expression: FaceExpression,
        privacy: Boolean,
        eyesClosed: Boolean,
        compactFraction: Float,
        staticForScreenshot: Boolean,
    )
}

/**
 * Per-face voice. With Android's platform TextToSpeech the in-scope levers are
 * pitch, speech rate, and the engine voice/locale. A deeper vocoded timbre
 * (e.g. a "true" Vader) would need output-side DSP or a cloud TTS voice — out of
 * scope here; see DockTts + the plan's note.
 */
data class VoiceProfile(
    val pitch: Float = 1.05f,        // DockTts' historical default
    val rate: Float = 1.0f,
    val voiceName: String? = null,   // optional engine Voice.getName(); null = default
    val locale: Locale = Locale.US,
)

/**
 * Per-face colour set. Defaults reproduce the original [DockPalette] (Aurora's
 * baby-blue look) so a face that overrides nothing looks like the old face.
 */
data class FacePalette(
    val background: Color = DockPalette.Background,
    val eyeBase: Color = DockPalette.EyeBase,
    val eyeBright: Color = DockPalette.EyeBright,
    val eyeDim: Color = DockPalette.EyeDim,
    val eyeGlow: Color = DockPalette.EyeGlow,
    val cheek: Color = DockPalette.Cheek,
    val pupil: Color = DockPalette.Pupil,
    val catchlight: Color = DockPalette.Catchlight,
    val onBackground: Color = DockPalette.OnBackground,
    val accent: Color = DockPalette.Accent,
    val bad: Color = DockPalette.Bad,
)
