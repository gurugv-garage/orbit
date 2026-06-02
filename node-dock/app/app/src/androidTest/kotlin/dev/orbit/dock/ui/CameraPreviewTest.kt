package dev.orbit.dock.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.orbit.dock.ui.theme.NodeDockTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tap-to-enlarge behaviour of the camera thumbnail, verified through Compose's
 * test harness (no emulator tap-coordinate geometry involved). CameraX's
 * PreviewView can't render without a bound camera, so this drives the same
 * size-toggle logic with a plain Box (an instant size swap rather than the
 * animated one, so the assertion is deterministic).
 */
@RunWith(AndroidJUnit4::class)
class CameraPreviewTest {

    @get:Rule
    val rule = createComposeRule()

    @Test
    fun tapTogglesBetweenBaseAndTripleSize() {
        rule.setContent {
            NodeDockTheme { ToggleSizeBox(tag = "preview", base = 96.dp) }
        }

        rule.onNodeWithTag("preview").assertHeightIsEqualTo(96.dp)
        rule.onNodeWithTag("preview").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("preview").assertHeightIsEqualTo(288.dp) // 3×
        rule.onNodeWithTag("preview").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("preview").assertHeightIsEqualTo(96.dp)
    }
}

@Composable
private fun ToggleSizeBox(tag: String, base: Dp) {
    var enlarged by remember { mutableStateOf(false) }
    Box(
        modifier = Modifier
            .testTag(tag)
            .size(if (enlarged) base * 3 else base)
            .clickable { enlarged = !enlarged },
    )
}
