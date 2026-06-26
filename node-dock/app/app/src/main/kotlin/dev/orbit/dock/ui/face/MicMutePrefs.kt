package dev.orbit.dock.ui.face

import android.content.Context

/**
 * Tiny SharedPreferences store for the user's mic-mute toggle, so "mic off" SURVIVES
 * an app restart — a restart must not silently re-open the mic (the icon now reflects
 * this intent, so a restored mute is visible). Mirrors [FaceStylePrefs].
 */
object MicMutePrefs {
    private const val PREFS = "orbit_mic"
    private const val KEY = "micMuted"

    fun get(context: Context): Boolean =
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY, false)

    fun set(context: Context, muted: Boolean) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY, muted).apply()
    }
}
