package dev.orbit.dock.station

import android.content.Context

/**
 * Local cache of the dock name this device last LEARNED from the station's
 * welcome frame (docs/decision-traces/runtime-dock-binding.md).
 *
 * The station's deviceId→dock binding is the source of truth; this cache only
 * lets the app re-announce its dock instantly on the next connect (send it in
 * `hello`) instead of waiting to be re-resolved. It's wiped on uninstall —
 * that's fine: the station re-supplies the name via welcome (keyed by the
 * uninstall-stable [DeviceId]).
 *
 * A compile-time DOCK_NAME (BuildConfig) is a pure DEV OVERRIDE, honored ONLY
 * when it's set AND nothing is cached. It is deliberately NOT persisted to the
 * cache and NOT preferred over an existing cache — a stale baked name must never
 * resurrect after a console claim (that bug re-bound a claimed device to its old
 * hardcoded dock). The station's binding (keyed by the uninstall-stable
 * [DeviceId]) is the source of truth; an unconfigured build dials in UNCLAIMED.
 */
object DockBindingCache {
    private const val PREFS = "orbit_identity"
    private const val KEY = "boundDock"

    /** The cached dock name, or null/blank when unclaimed. */
    fun get(context: Context): String? =
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY, null)
            ?.takeIf { it.isNotBlank() }

    /** Persist the dock name learned from a welcome frame (or a dev override). */
    fun set(context: Context, dock: String) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, dock).apply()
    }

    fun clear(context: Context) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY).apply()
    }

    /**
     * Resolve the dock to send at startup: the CACHED name (learned from a prior
     * welcome) wins; only if nothing is cached does the dev-override apply. The
     * override is NOT written to the cache — so once the station re-supplies the
     * real name via welcome, that name takes over and the stale baked value never
     * comes back. Returns null when neither is set — the app dials in UNCLAIMED
     * and is claimed from the console.
     */
    fun resolveInitial(context: Context, buildOverride: String): String? {
        get(context)?.let { return it }
        return buildOverride.takeIf { it.isNotBlank() }
    }
}
