package dev.orbit.dock.ui.devbar

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.orbit.dock.BuildConfig
import dev.orbit.dock.ui.face.FaceController

/**
 * Renders the dev test panel in debug builds only.
 *
 * Tabs: TEXT (transcript injector), EMOTION (direct setExpression),
 * STATE (force FaceState). See [DevPanel].
 *
 * In release builds this composable is a no-op (Kotlin compiler
 * eliminates the dead branch since BuildConfig.DEBUG is a compile-time
 * constant).
 */
@Composable
fun DevBarHost(controller: FaceController, modifier: Modifier = Modifier) {
    if (BuildConfig.DEBUG) {
        DevPanel(controller = controller, modifier = modifier)
    }
}
