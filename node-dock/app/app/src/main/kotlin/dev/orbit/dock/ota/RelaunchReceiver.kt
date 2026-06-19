package dev.orbit.dock.ota

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import timber.log.Timber

/**
 * Relaunch the dock after it's been updated (or the phone rebooted).
 *
 * Why this exists: after a self-update, Android kills the app and does NOT
 * relaunch it — and relaunching from the OTA install-result receiver races the
 * process kill (the dying process often can't start an activity in time). The
 * reliable path is MY_PACKAGE_REPLACED: Android delivers it to the *freshly
 * updated* app in a NEW process, so the relaunch always survives. We also handle
 * BOOT_COMPLETED so a dock appliance comes back after a power cycle.
 *
 * See docs/ota.md §5.
 */
class RelaunchReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_BOOT_COMPLETED -> {
                Timber.i("RelaunchReceiver: ${intent.action} → relaunching dock")
                val launch = context.packageManager
                    .getLaunchIntentForPackage(context.packageName)
                    ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { launch?.let { context.startActivity(it) } }
                    .onFailure { Timber.w(it, "RelaunchReceiver: launch failed") }
            }
        }
    }
}
