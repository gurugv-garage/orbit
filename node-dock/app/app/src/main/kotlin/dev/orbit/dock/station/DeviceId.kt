package dev.orbit.dock.station

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings

/**
 * The app's STABLE hardware identity for the hello `id` and the station's
 * deviceId→dock binding (docs/modules/runtime-dock-binding.md).
 *
 * Uses [Settings.Secure.ANDROID_ID]: on Android 8+ it's scoped to
 * (app signing key + user + device) and — crucially — survives app
 * UNINSTALL/REINSTALL as long as the APK keeps the same signing key. That's the
 * property the binding needs: a reinstalled app re-presents the same id, so the
 * station re-supplies its dock name with no re-claim. (The old install-UUID in
 * [InstallId] was minted in app-private prefs and is wiped on uninstall — fine
 * for telling two live phones apart, useless as the uninstall-proof binding key.)
 *
 * Caveats (the unclaimed-reclaim flow in the console is the safety net):
 *  - a factory reset or a change of signing key yields a NEW id (re-claim once);
 *  - a debug APK signed with an auto-generated keystore is stable on one build
 *    machine but differs across machines.
 *
 * We prefix "app-" so the id is self-describing on the wire / in the roster,
 * matching the firmware's "body-<mac>" convention.
 */
object DeviceId {
    @SuppressLint("HardwareIds") // ANDROID_ID is the intended, uninstall-stable key here
    fun get(context: Context): String {
        val androidId = Settings.Secure.getString(
            context.applicationContext.contentResolver,
            Settings.Secure.ANDROID_ID,
        )
        // ANDROID_ID can be null/blank on some early-boot or odd ROMs; fall back
        // to the persisted install UUID so we never send an empty id.
        return if (!androidId.isNullOrBlank()) "app-$androidId" else InstallId.get(context)
    }
}
