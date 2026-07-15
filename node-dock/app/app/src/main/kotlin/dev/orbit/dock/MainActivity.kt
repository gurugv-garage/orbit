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
            Timber.i("MainActivity received FORCE_FINISH — finishing + removing task")
            // finishAndRemoveTask so a clean exit (Exit button or notification
            // "Stop dock") also clears the app from Recents. The service has
            // already dropped its notification + stopped itself; the now-empty
            // process is harmless and the OS reaps it. We deliberately do NOT
            // Process.killProcess() here — killing the process can race the
            // foreground-notification removal and leave the notification stuck.
            finishAndRemoveTask()
        }
    }

    // Debug-only: fire the AEC self-test from adb without UI taps:
    //   adb shell am broadcast -a dev.orbit.dock.RUN_AEC_TEST
    // Verdict lands in logcat under the AEC_TEST tag.
    private val aecTestReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            Timber.i("MainActivity received RUN_AEC_TEST")
            dev.orbit.dock.perception.PerceptionBus.emit(
                dev.orbit.dock.perception.PerceptionEvent.RunAecTest,
            )
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
        if (BuildConfig.DEBUG) {
            ContextCompat.registerReceiver(
                this,
                aecTestReceiver,
                IntentFilter("dev.orbit.dock.RUN_AEC_TEST"),
                ContextCompat.RECEIVER_EXPORTED,
            )
        }

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

        // TEST HOOK: let the station screenshot this window over the `face` cap.
        // No adb on this dock (OTA deploys), so this is the ONLY way to see what
        // the face actually renders — see debug/ScreenCapture.kt.
        dev.orbit.dock.debug.ScreenCapture.activity = this

        setContent {
            NodeDockTheme {
                DockScreen()
            }
        }
    }

    override fun onDestroy() {
        if (dev.orbit.dock.debug.ScreenCapture.activity === this) {
            dev.orbit.dock.debug.ScreenCapture.activity = null
        }
        try { unregisterReceiver(forceFinishReceiver) } catch (_: Throwable) {}
        if (BuildConfig.DEBUG) {
            try { unregisterReceiver(aecTestReceiver) } catch (_: Throwable) {}
        }
        super.onDestroy()
    }
}
