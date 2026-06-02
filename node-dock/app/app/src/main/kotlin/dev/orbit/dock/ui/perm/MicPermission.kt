package dev.orbit.dock.ui.perm

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

data class PermissionsState(
    val mic: Boolean,
    val camera: Boolean,
)

/**
 * Returns the current grant state for RECORD_AUDIO, CAMERA, and
 * POST_NOTIFICATIONS (Android 13+). Requests on first composition.
 */
@Composable
fun rememberPermissions(): PermissionsState {
    val ctx = LocalContext.current
    var mic by remember { mutableStateOf(hasPermission(ctx, Manifest.permission.RECORD_AUDIO)) }
    var camera by remember { mutableStateOf(hasPermission(ctx, Manifest.permission.CAMERA)) }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        if (results.containsKey(Manifest.permission.RECORD_AUDIO)) {
            mic = results[Manifest.permission.RECORD_AUDIO] == true
        }
        if (results.containsKey(Manifest.permission.CAMERA)) {
            camera = results[Manifest.permission.CAMERA] == true
        }
    }

    LaunchedEffect(Unit) {
        val needed = mutableListOf<String>()
        if (!mic) needed += Manifest.permission.RECORD_AUDIO
        if (!camera) needed += Manifest.permission.CAMERA
        if (Build.VERSION.SDK_INT >= 33 &&
            !hasPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        if (needed.isNotEmpty()) launcher.launch(needed.toTypedArray())
    }
    return PermissionsState(mic = mic, camera = camera)
}

/** Backwards-compat shim: legacy callers asking for just mic. */
@Composable
fun rememberMicPermission(): Boolean = rememberPermissions().mic

fun hasPermission(ctx: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED
