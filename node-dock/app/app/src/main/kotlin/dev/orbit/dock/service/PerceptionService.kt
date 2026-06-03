package dev.orbit.dock.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.orbit.dock.MainActivity
import dev.orbit.dock.R
import dev.orbit.dock.perception.PerceptionPipeline
import timber.log.Timber

/**
 * Foreground service hosting the always-on mic pipeline.
 *
 * `foregroundServiceType="microphone"` (Android 14+ requirement). Persistent
 * notification is intentional — system requires it; we treat it as an honest
 * "I'm listening" indicator.
 */
class PerceptionService : Service() {

    private lateinit var pipeline: PerceptionPipeline

    override fun onCreate() {
        super.onCreate()
        Timber.d("PerceptionService onCreate")
        pipeline = PerceptionPipeline(applicationContext)
        startInForeground()
        pipeline.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Timber.i("PerceptionService received ACTION_STOP — shutting down")
            shutdown()
            return START_NOT_STICKY
        }
        // NOT_STICKY: if the system kills us (or the task is removed) we do NOT
        // want Android to silently resurrect the listening service + its
        // notification. The dock only listens while the user has it open.
        return START_NOT_STICKY
    }

    /**
     * The task was swiped away from Recents. A foreground mic service would
     * otherwise keep running (with its notification) after the app is "closed";
     * tear everything down so closing the app really closes it.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Timber.i("PerceptionService onTaskRemoved — app dismissed, shutting down")
        shutdown()
        super.onTaskRemoved(rootIntent)
    }

    /** Full teardown: stop the pipeline, drop the notification, stop the
     *  service, and tell the activity (if any) to finish. */
    private fun shutdown() {
        // Drop the notification + stop the service FIRST (synchronously), THEN
        // tell the activity to finish — the activity kills the process on that
        // broadcast, so the notification must already be gone by then.
        // (pipeline.stop() runs in onDestroy.)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        sendBroadcast(Intent(BROADCAST_FORCE_FINISH).setPackage(packageName))
    }

    override fun onDestroy() {
        Timber.d("PerceptionService onDestroy")
        pipeline.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Dock perception",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "Mic + VAD always-on" }
            )
        }

        val pi = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        // "Stop dock" action — fires ACTION_STOP back at this service and
        // (via the service's broadcast) finishes MainActivity too.
        val stopPi = PendingIntent.getService(
            this,
            1,
            Intent(this, PerceptionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("orbit dock")
            .setContentText("listening")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .addAction(
                NotificationCompat.Action.Builder(
                    R.drawable.ic_launcher_foreground,
                    "Stop dock",
                    stopPi,
                ).build()
            )
            .build()

        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    companion object {
        const val CHANNEL_ID = "perception"
        const val NOTIF_ID = 1001
        const val ACTION_STOP = "dev.orbit.dock.action.STOP"
        const val BROADCAST_FORCE_FINISH = "dev.orbit.dock.action.FORCE_FINISH"

        fun start(context: Context) {
            val intent = Intent(context, PerceptionService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PerceptionService::class.java))
        }

        /** Full app shutdown: fire the service's ACTION_STOP path, which tears
         *  down the pipeline + notification and broadcasts FORCE_FINISH so the
         *  activity finishes too. Used by the in-app Exit button. Safe even if
         *  the service isn't currently running. */
        fun exit(context: Context) {
            val i = Intent(context, PerceptionService::class.java).setAction(ACTION_STOP)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i)
            else context.startService(i)
        }
    }
}
