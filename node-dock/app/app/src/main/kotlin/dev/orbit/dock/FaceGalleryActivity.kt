package dev.orbit.dock

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.ui.face.Face
import dev.orbit.dock.ui.face.FaceExpression
import dev.orbit.dock.ui.face.FaceRegistry
import dev.orbit.dock.ui.face.FaceState
import dev.orbit.dock.ui.face.GazeOffset
import dev.orbit.dock.ui.theme.DockPalette
import dev.orbit.dock.ui.theme.NodeDockTheme

/**
 * Debug-only screen that renders every [Face] in [FaceRegistry] across every
 * [FaceExpression], so we can adb-screencap and compare faces + renderer
 * iterations side-by-side. All cells render `staticForScreenshot = true` so each
 * capture is deterministic (no breath / blink / drift).
 *
 * Launch (all faces, one labeled row each):
 *   adb shell am start -n dev.orbit.dock/.FaceGalleryActivity
 * One face only (its id, e.g. vader):
 *   adb shell am start -n dev.orbit.dock/.FaceGalleryActivity -e face vader
 */
class FaceGalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val only = intent?.getStringExtra("face")
        setContent {
            NodeDockTheme {
                FaceGallery(only)
            }
        }
    }
}

private data class Cell(
    val label: String,
    val expression: FaceExpression,
    val state: FaceState = FaceState.Speaking,
    val privacy: Boolean = false,
)

private val CELLS: List<Cell> = listOf(
    Cell("neutral", FaceExpression.Neutral, FaceState.Idle),
    Cell("happy", FaceExpression.Happy),
    Cell("curious", FaceExpression.Curious, FaceState.Engaged),
    Cell("concerned", FaceExpression.Concerned, FaceState.Listening),
    Cell("surprised", FaceExpression.Surprised, FaceState.Engaged),
    Cell("sleepy", FaceExpression.Sleepy, FaceState.Idle),
    Cell("wink", FaceExpression.Wink),
    Cell("sad", FaceExpression.Sad, FaceState.Idle),
    Cell("excited", FaceExpression.Excited),
    Cell("angry", FaceExpression.Angry, FaceState.Engaged),
    Cell("love", FaceExpression.Love),
    Cell("privacy", FaceExpression.Sleepy, FaceState.Idle, privacy = true),
)

@Composable
private fun FaceGallery(onlyFaceId: String?) {
    val faces = if (onlyFaceId != null) listOf(FaceRegistry.byId(onlyFaceId)) else FaceRegistry.faces
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(DockPalette.Background)
            .padding(8.dp),
    ) {
        Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            for (face in faces) {
                Text(
                    face.label,
                    color = Color(0xFFE0EAF0),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 2.dp),
                )
                // 2 rows × 6 cols for this face's 12 cells.
                for (row in 0 until 2) {
                    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        for (col in 0 until 6) {
                            val i = row * 6 + col
                            if (i < CELLS.size) {
                                FaceCell(
                                    face = face,
                                    cell = CELLS[i],
                                    modifier = Modifier
                                        .weight(1f)
                                        .aspectRatio(1.1f)
                                        .padding(horizontal = 3.dp),
                                )
                            } else {
                                Box(modifier = Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FaceCell(face: Face, cell: Cell, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .clip(RoundedCornerShape(10.dp))
                .background(face.palette.background),
            contentAlignment = Alignment.Center,
        ) {
            face.Render(
                modifier = Modifier.fillMaxSize(),
                state = cell.state,
                gaze = GazeOffset(),
                expression = cell.expression,
                privacy = cell.privacy,
                eyesClosed = false,
                compactFraction = 1f,
                staticForScreenshot = true,
            )
        }
        Text(
            cell.label,
            color = Color(0xFFA3B7C2),
            fontSize = 9.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        )
    }
}
