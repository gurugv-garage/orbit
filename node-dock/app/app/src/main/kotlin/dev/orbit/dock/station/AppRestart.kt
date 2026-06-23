package dev.orbit.dock.station

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import timber.log.Timber

/**
 * Cleanly restart the dock app's OWN process (runtime dock binding —
 * docs/decision-traces/runtime-dock-binding.md).
 *
 * Why a full process restart: when this device is MOVED to a different dock, the
 * only fail-proof reset is to throw away ALL in-memory state — boundDock, the
 * session id + logs shown in the UI, the remember{}-ed StationLink / MediaStreamer
 * (whose SFU label was frozen at the old dock) / RemoteBrain, every coroutine and
 * cache. A WS reconnect keeps the process (and those stale captures) alive; a
 * process restart guarantees a clean rebuild as the new dock.
 *
 * Mechanism: schedule the launcher Activity via AlarmManager a moment from now,
 * then exit the process. Android starts the fresh process at the alarm, so the
 * relaunch survives our own death (the dying process can't reliably startActivity).
 */
object AppRestart {
    /** Restart the app process after [delayMs], to allow a UI message to show. */
    fun now(context: Context, delayMs: Long = 1200L) {
        val ctx = context.applicationContext
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (launch == null) {
            Timber.e("AppRestart: no launch intent — exiting without relaunch")
            Runtime.getRuntime().exit(0)
            return
        }
        val pi = PendingIntent.getActivity(
            ctx, 0, launch,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
        )
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.set(AlarmManager.RTC, System.currentTimeMillis() + delayMs, pi)
        Timber.w("AppRestart: relaunch scheduled in ${delayMs}ms — exiting process now")
        Runtime.getRuntime().exit(0)
    }
}
