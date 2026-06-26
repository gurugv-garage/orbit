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
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import timber.log.Timber
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest

/**
 * App self-update over OTA (docs/ota.md §5). Given an `ota/available` offer
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
    private val currentVersionCode: Int,
    private val publish: (kind: String, payload: JsonObject) -> Unit,
) {
    private val installing = Mutex()

    // OWN, application-lifetime scope — an OTA download/install must NOT be tied
    // to a Compose composition (which recomposes/leaves constantly on the dock's
    // animated face, cancelling the update mid-flight with
    // LeftCompositionCancellationException). SupervisorJob so one failure doesn't
    // poison future offers; IO dispatcher for the network + file work.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        private const val INSTALL_ACTION = "dev.orbit.dock.ota.INSTALL_RESULT"
    }

    /** A newer build the station has offered, awaiting the user's tap. Null = nothing pending.
     *  OPT-IN model (this dev dock): we do NOT silently auto-install — the UI shows a "build N
     *  available" affordance and the user taps to apply (startPendingUpdate). Avoids a surprise
     *  restart mid-test. `progress` reflects an in-flight apply ("downloading"/"verifying"/…). */
    data class Available(val build: Int, val version: String, val url: String, val sha256: String, val progress: String? = null)
    private val _available = MutableStateFlow<Available?>(null)
    val available: StateFlow<Available?> = _available.asStateFlow()

    /**
     * Handle an `ota/available` offer payload { target:"app", build, version, url, sha256,
     * size }. No-op unless `target=="app"`, strictly newer, and not already installing. Does
     * NOT install — it records the offer as PENDING for the UI; the user applies it via
     * [startPendingUpdate]. (Was silent auto-install; made opt-in per the dev-dock workflow.)
     */
    fun onOffer(target: String?, build: Int?, url: String?, sha256: String?, version: String? = null) {
        if (target != "app") return
        if (build == null || url == null || sha256 == null) {
            Timber.w("OTA: malformed app offer — ignoring"); return
        }
        if (build <= currentVersionCode) {
            Timber.i("OTA: offer build $build <= current $currentVersionCode — skipping"); return
        }
        // Record (or refresh) the pending offer for the UI; don't clobber an in-flight apply.
        if (_available.value?.progress == null) {
            _available.value = Available(build, version ?: "0.1.$build", url, sha256)
            Timber.i("OTA: build $build available (awaiting user tap)")
        }
    }

    /** User tapped the build number → ask the station to RE-CHECK for an update and
     *  re-offer if this dock is behind. The app is otherwise passive (it waits for the
     *  station's push); this is a manual poke so you don't have to wait for the next
     *  peer-join/heartbeat re-announce. Publishes an `ota/check` frame carrying our
     *  current build; the station replies with an `ota/available` offer iff it has a
     *  newer artifact (handled by [onOffer]). No-op visible here if already up to date. */
    fun requestCheck() {
        Timber.i("OTA: manual update check (current build $currentVersionCode)")
        publish("check", buildJsonObject {
            put("target", "app")
            put("build", currentVersionCode)
        })
    }

    /** User tapped "update": apply the pending offer (download → verify → install). Safe to
     *  call repeatedly — ignored if nothing pending or an apply is already running. */
    fun startPendingUpdate() {
        val offer = _available.value ?: return
        scope.launch {
            if (!installing.tryLock()) { Timber.i("OTA: already installing — ignoring tap"); return@launch }
            try {
                _available.value = offer.copy(progress = "starting")
                runUpdate(offer.build, offer.url, offer.sha256)
            } catch (t: Throwable) {
                Timber.e(t, "OTA: update failed")
                _available.value = offer.copy(progress = "failed: ${t.message ?: "error"}")
                result(offer.build, ok = false, error = t.message ?: "update failed")
            } finally {
                installing.unlock()
            }
        }
    }

    private suspend fun runUpdate(build: Int, url: String, wantSha: String) {
        // Stream to a file, never into RAM: a release APK is ~200 MB and a
        // ByteArray of that size OOMs low-heap phones instantly. download()
        // computes the sha256 as it writes, so there's no second full read.
        val staged = File(context.cacheDir, "ota-$build.apk")
        try {
            progress("downloading", 0)
            val gotSha = withContext(Dispatchers.IO) { downloadTo(url, staged) }

            progress("verifying", null)
            if (!gotSha.equals(wantSha, ignoreCase = true)) {
                result(build, ok = false, error = "sha256 mismatch")
                return
            }

            progress("applying", null)
            withContext(Dispatchers.IO) { installApk(staged) }
            // On a successful silent install the process is replaced; we won't
            // reach here. With the confirm dialog, the user acts asynchronously.
            // Either way the new versionCode in the next `hello` is the proof.
            Timber.i("OTA: install committed for build $build")
        } finally {
            // PackageInstaller has copied the bytes into its own session by the
            // time commit returns; the staged file is no longer needed.
            staged.delete()
        }
    }

    /**
     * Stream the APK from `url` to `dest`, hashing as we go. Returns the sha256
     * hex. Constant memory (64 KB buffer) regardless of APK size.
     */
    private fun downloadTo(url: String, dest: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000; readTimeout = 30000
        }
        try {
            val total = conn.contentLength
            DigestInputStream(conn.inputStream, md).use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var read: Int
                    var got = 0L
                    var lastPct = -1
                    while (input.read(buf).also { read = it } != -1) {
                        out.write(buf, 0, read)
                        got += read
                        if (total > 0) {
                            val pct = (got * 100 / total).toInt()
                            if (pct != lastPct && pct % 10 == 0) { lastPct = pct; progress("downloading", pct) }
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Stream the staged APK file into a PackageInstaller session and commit. */
    private fun installApk(apk: File) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = pi.createSession(params)
        pi.openSession(sessionId).use { session ->
            session.openWrite("dock.apk", 0, apk.length()).use { os ->
                apk.inputStream().use { it.copyTo(os, 64 * 1024) }
                session.fsync(os)
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

    private fun progress(phase: String, pct: Int?) {
        // mirror to the UI's pending-offer state so the affordance shows live apply progress.
        _available.value = _available.value?.copy(progress = if (pct != null) "$phase ${pct}%" else phase)
        publish("progress", buildJsonObject {
            put("target", "app"); put("phase", phase); if (pct != null) put("pct", pct)
        })
    }

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
                        // Update applied; Android now kills us. Relaunch is NOT
                        // done here (the dying process races the kill) — the new
                        // post-update process gets MY_PACKAGE_REPLACED and
                        // RelaunchReceiver starts the app back up. See docs/ota.md §5.
                        Timber.i("OTA: install succeeded — RelaunchReceiver will restart the new build")
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
