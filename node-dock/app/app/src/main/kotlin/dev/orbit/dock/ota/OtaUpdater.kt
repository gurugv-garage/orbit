package dev.orbit.dock.ota

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import timber.log.Timber
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * App self-update over OTA (docs/OTA.md §5). Given an `ota/available` offer
 * from the station, downloads the APK, verifies its sha256, and installs it via
 * [PackageInstaller]. As **device owner** the install is silent (no tap); else
 * the system shows a confirm dialog. Android independently refuses any APK not
 * signed with the installed app's key, and any versionCode ≤ the current one —
 * so a rogue station cannot push a foreign or downgrade APK.
 *
 * Reports phase/result back to the station on the `ota` topic (for the console
 * phase bar) via [publish].
 *
 * @param publish (kind, payload) → station publish on the `ota` topic. Wired to
 *                StationLink.publish("ota", kind, payload).
 */
class OtaUpdater(
    private val context: Context,
    private val scope: CoroutineScope,
    private val currentVersionCode: Int,
    private val publish: (kind: String, payload: JsonObject) -> Unit,
) {
    private val installing = Mutex()

    companion object {
        private const val INSTALL_ACTION = "dev.orbit.dock.ota.INSTALL_RESULT"
    }

    /**
     * Handle an `ota/available` offer payload { target:"app", build, version,
     * url, sha256, size }. No-op unless `target=="app"`, the offer is strictly
     * newer, and no install is already running.
     */
    fun onOffer(target: String?, build: Int?, url: String?, sha256: String?) {
        if (target != "app") return
        if (build == null || url == null || sha256 == null) {
            Timber.w("OTA: malformed app offer — ignoring"); return
        }
        if (build <= currentVersionCode) {
            Timber.i("OTA: offer build $build <= current $currentVersionCode — skipping"); return
        }
        scope.launch {
            if (!installing.tryLock()) { Timber.i("OTA: already installing — ignoring offer"); return@launch }
            try {
                runUpdate(build, url, sha256)
            } catch (t: Throwable) {
                Timber.e(t, "OTA: update failed")
                result(build, ok = false, error = t.message ?: "update failed")
            } finally {
                installing.unlock()
            }
        }
    }

    private suspend fun runUpdate(build: Int, url: String, wantSha: String) {
        progress("downloading", 0)
        val apk = withContext(Dispatchers.IO) { download(url) }

        progress("verifying", null)
        val gotSha = withContext(Dispatchers.IO) { sha256Hex(apk) }
        if (!gotSha.equals(wantSha, ignoreCase = true)) {
            result(build, ok = false, error = "sha256 mismatch")
            return
        }

        progress("applying", null)
        withContext(Dispatchers.IO) { installApk(apk) }
        // On a successful silent install the process is replaced; we won't reach
        // here. With the confirm dialog, the user acts asynchronously. Either
        // way the new versionCode in the next `hello` is the real confirmation.
        Timber.i("OTA: install committed for build $build")
    }

    /** Stream the APK to a private session staging file. */
    private fun download(url: String): ByteArray {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000; readTimeout = 30000
        }
        try {
            val total = conn.contentLength
            conn.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream(if (total > 0) total else 1 shl 20)
                val buf = ByteArray(64 * 1024)
                var read: Int
                var got = 0
                var lastPct = -1
                while (input.read(buf).also { read = it } != -1) {
                    out.write(buf, 0, read)
                    got += read
                    if (total > 0) {
                        val pct = (got.toLong() * 100 / total).toInt()
                        if (pct != lastPct && pct % 10 == 0) { lastPct = pct; progress("downloading", pct) }
                    }
                }
                return out.toByteArray()
            }
        } finally {
            conn.disconnect()
        }
    }

    /** Write the APK into a PackageInstaller session and commit it. */
    private fun installApk(apk: ByteArray) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = pi.createSession(params)
        pi.openSession(sessionId).use { session ->
            session.openWrite("dock.apk", 0, apk.size.toLong()).use { os ->
                os.write(apk); session.fsync(os)
            }
            val intent = Intent(INSTALL_ACTION).setPackage(context.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
            session.commit(pending.intentSender)
        }
    }

    /** True if this app is the device owner (→ silent installs, no confirm dialog). */
    fun isDeviceOwner(): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(context.packageName)
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }

    private fun progress(phase: String, pct: Int?) =
        publish("progress", buildJsonObject {
            put("target", "app"); put("phase", phase); if (pct != null) put("pct", pct)
        })

    private fun result(build: Int, ok: Boolean, error: String?) =
        publish("result", buildJsonObject {
            put("target", "app"); put("build", build)
            put("ok", ok); if (error != null) put("error", error)
        })

    /**
     * Register a receiver for PackageInstaller commit results so a confirm-dialog
     * (non-device-owner) flow can surface STATUS_PENDING_USER_ACTION, and so
     * failures get reported. Call once (e.g. from the Activity/Service that owns
     * the updater). Returns an unregister fn.
     */
    fun registerInstallResultReceiver(): () -> Unit {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)
                when (status) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        // Not device-owner: launch the system confirm dialog.
                        @Suppress("DEPRECATION")
                        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        confirm?.let { runCatching { context.startActivity(it) } }
                    }
                    PackageInstaller.STATUS_SUCCESS ->
                        Timber.i("OTA: install succeeded (process will be replaced)")
                    else -> {
                        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                        Timber.w("OTA: install failed status=$status msg=$msg")
                        publish("result", buildJsonObject {
                            put("target", "app"); put("ok", false); put("error", "install status $status: $msg")
                        })
                    }
                }
            }
        }
        val filter = IntentFilter(INSTALL_ACTION)
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        return { runCatching { context.unregisterReceiver(receiver) } }
    }
}
