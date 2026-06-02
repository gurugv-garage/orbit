package dev.orbit.dock.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Dock palette — always dark; the dock screen is always on. */
object DockPalette {
    val Background = Color(0xFF06090C)
    val SurfaceLow = Color(0xFF0A1014)
    val SurfaceMid = Color(0xFF111A21)

    val EyeBase = Color(0xFF8FD0F0)      // soft baby blue
    val EyeBright = Color(0xFFB7E4FF)    // engaged / speaking
    val EyeDim = Color(0xFF3C5D6E)       // privacy / sleepy
    val EyeGlow = Color(0xFF4FB6E8)      // halo
    val Cheek = Color(0xFFFF9DAE)        // soft pink, when speaking
    val Pupil = Color(0xFF06090C)
    val Catchlight = Color(0xFFE9F6FF)

    val OnBackground = Color(0xFFD9E7EE)
    val OnBackgroundDim = Color(0xFF6F8895)
    val Accent = Color(0xFF9DDDFF)
    val Warn = Color(0xFFFFBE5C)
    val Good = Color(0xFF7FE08C)
    val Bad = Color(0xFFFF7B7B)
}

private val DockDarkColors = darkColorScheme(
    primary = DockPalette.Accent,
    onPrimary = Color(0xFF002A3A),
    secondary = Color(0xFFB8C7D0),
    background = DockPalette.Background,
    surface = DockPalette.SurfaceMid,
    onBackground = DockPalette.OnBackground,
    onSurface = DockPalette.OnBackground,
)

@Composable
fun NodeDockTheme(
    content: @Composable () -> Unit,
) {
    // Always dark — the dock is always-on; light mode would be a glare.
    MaterialTheme(colorScheme = DockDarkColors, content = content)
}
