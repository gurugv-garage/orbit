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
 * A compile-time DOCK_NAME (BuildConfig) is treated as a one-time dev override:
 * if set and nothing is cached yet, we seed the cache with it (the app then
 * self-binds on the server). Empty default = no override; the app starts
 * unclaimed and is claimed from the console.
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
     * Resolve the dock to use at startup: the cached name if present, else the
     * compile-time override (which we then seed into the cache). Returns null
     * when neither is set — the app dials in UNCLAIMED.
     */
    fun resolveInitial(context: Context, buildOverride: String): String? {
        get(context)?.let { return it }
        if (buildOverride.isNotBlank()) {
            set(context, buildOverride)
            return buildOverride
        }
        return null
    }
}
