package dev.orbit.dock.ui.face

import android.content.Context

/**
 * Tiny SharedPreferences store for the user's chosen face id, so a live face
 * switch (brain tool / dev picker) survives an app restart. Separate from
 * ConfigCache: this is the LOCAL override, not the station's `faceStyle` default.
 */
object FaceStylePrefs {
    private const val PREFS = "orbit_face"
    private const val KEY = "faceId"

    fun get(context: Context): String? =
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY, null)

    fun set(context: Context, id: String) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, id).apply()
    }
}
