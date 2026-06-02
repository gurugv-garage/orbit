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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.ui.face.FaceExpression
import dev.orbit.dock.ui.face.FaceRenderer
import dev.orbit.dock.ui.face.FaceState
import dev.orbit.dock.ui.face.GazeOffset
import dev.orbit.dock.ui.theme.DockPalette
import dev.orbit.dock.ui.theme.NodeDockTheme

/**
 * Debug-only screen that renders every [FaceExpression] in a grid so we
 * can adb-screencap and compare renderer iterations side-by-side.
 * All cells render with `staticForScreenshot = true` so each capture is
 * deterministic (no breath / blink / drift).
 *
 * Launch:
 *   adb shell am start -n dev.orbit.dock/.FaceGalleryActivity
 */
class FaceGalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            NodeDockTheme {
                FaceGallery()
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
private fun FaceGallery() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(DockPalette.Background)
            .padding(8.dp),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // 3 rows × 4 cols
            for (row in 0 until 3) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(vertical = 4.dp),
                ) {
                    for (col in 0 until 4) {
                        val i = row * 4 + col
                        if (i < CELLS.size) {
                            FaceCell(
                                cell = CELLS[i],
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxSize()
                                    .padding(horizontal = 4.dp),
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

@Composable
private fun FaceCell(cell: Cell, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .clip(RoundedCornerShape(12.dp))
                .background(DockPalette.SurfaceLow),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .aspectRatio(2f),
            ) {
                FaceRenderer(
                    modifier = Modifier.fillMaxSize(),
                    state = cell.state,
                    gaze = GazeOffset(),
                    expression = cell.expression,
                    privacy = cell.privacy,
                    staticForScreenshot = true,
                )
            }
        }
        Text(
            cell.label,
            color = Color(0xFFA3B7C2),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 4.dp),
        )
    }
}
