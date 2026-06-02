package dev.orbit.dock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.orbit.dock.service.PerceptionService
import dev.orbit.dock.ui.DockScreen
import dev.orbit.dock.ui.theme.NodeDockTheme
import timber.log.Timber

class MainActivity : ComponentActivity() {

    // Broadcast from PerceptionService's ACTION_STOP path → finish the
    // activity so "Stop dock" on the persistent notification really
    // kills the whole UI, not just the listening service.
    private val forceFinishReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            Timber.i("MainActivity received FORCE_FINISH from notification")
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ContextCompat.registerReceiver(
            this,
            forceFinishReceiver,
            IntentFilter(PerceptionService.BROADCAST_FORCE_FINISH),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        // Stay awake — the dock never sleeps.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Immersive full-screen.
        enableEdgeToEdge()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).let {
            it.hide(WindowInsetsCompat.Type.systemBars())
            it.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        // Optional: cutout content so the face can use full screen on notched devices.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        setContent {
            NodeDockTheme {
                DockScreen()
            }
        }
    }

    override fun onDestroy() {
        try { unregisterReceiver(forceFinishReceiver) } catch (_: Throwable) {}
        super.onDestroy()
    }
}
