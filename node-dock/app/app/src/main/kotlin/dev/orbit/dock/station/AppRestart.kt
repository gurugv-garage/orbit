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
 * Reliability (this is an always-on appliance — it MUST come back):
 *   1. Start the launcher Activity NOW, from the live process, with
 *      NEW_TASK | CLEAR_TASK. That tears down the current task and queues a fresh
 *      MainActivity — done while we're still alive, so it doesn't depend on a
 *      post-death alarm (the unreliable part of the old approach).
 *   2. Also arm a Doze-exempt WAKING alarm as a backstop, in case the process is
 *      killed before the new task fully starts.
 *   3. Then exit, so the OS rebuilds us from scratch.
 */
object AppRestart {
    fun now(context: Context, delayMs: Long = 1200L) {
        val ctx = context.applicationContext
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (launch == null) {
            Timber.e("AppRestart: no launch intent — exiting without relaunch")
            Runtime.getRuntime().exit(0)
            return
        }

        // Backstop alarm: Doze-exempt + WAKING so a sleeping/dozing dock still
        // relaunches even if the in-process startActivity below loses the race.
        runCatching {
            val pi = PendingIntent.getActivity(
                ctx, 0, launch,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
            )
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            am.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + delayMs, pi,
            )
        }.onFailure { Timber.w(it, "AppRestart: backstop alarm failed (continuing)") }

        // Primary path: launch a fresh task from the live process, then exit.
        runCatching { ctx.startActivity(launch) }
            .onFailure { Timber.w(it, "AppRestart: startActivity failed (alarm is backstop)") }

        Timber.w("AppRestart: relaunch armed — exiting process now")
        Runtime.getRuntime().exit(0)
    }
}
