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
            // Tell MainActivity to finish (if it's running) so the user gets
            // a fully-killed app, not just a stopped service that the
            // activity-level perception observers can resurrect.
            sendBroadcast(
                Intent(BROADCAST_FORCE_FINISH).setPackage(packageName),
            )
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
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
    }
}
