package dev.orbit.dock.station

import android.content.Context

/**
 * The app's stable HARDWARE/INSTANCE identity for hello v2 (`id`) — a
 * persisted install UUID, minted once per installation.
 *
 * Deliberately NOT derived from the dock name: `id` exists to tell two
 * physical devices apart even when they claim the same `(dock, component)`
 * address (a hardware swap, or an old phone someone forgot to retire — seen
 * live: two different phones both calling themselves "anne-bot-app", making
 * the roster unreadable). The address binds state; the id names the metal.
 */
object InstallId {
    private const val PREFS = "orbit_identity"
    private const val KEY = "installId"

    fun get(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }
        val id = "app-" + java.util.UUID.randomUUID().toString().take(8)
        prefs.edit().putString(KEY, id).apply()
        return id
    }
}
