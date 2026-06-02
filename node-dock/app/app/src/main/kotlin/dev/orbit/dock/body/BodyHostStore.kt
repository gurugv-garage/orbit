package dev.orbit.dock.body

import android.content.Context
import android.content.SharedPreferences

/**
 * Persists a small history of BodyLink hosts the app has successfully
 * connected to. Newest-first, deduplicated, capped at [MAX].
 *
 * Used by the connect dialog: every successful handshake records its host;
 * the dialog shows the history as a quick-pick list with per-entry delete.
 */
class BodyHostStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("bodylink_hosts", Context.MODE_PRIVATE)

    /** Most-recent-first list of previously-working hosts (e.g. "192.168.1.10:17317"). */
    fun history(): List<String> {
        val raw = prefs.getString(KEY_HISTORY, "") ?: ""
        return raw.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
    }

    /** The host to use on launch: most-recent success, or null if none yet. */
    fun lastHost(): String? = history().firstOrNull()

    /** Record a host that just connected successfully. Moves it to the front,
     *  dedups, caps at MAX. */
    fun recordSuccess(host: String) {
        val h = host.trim()
        if (h.isEmpty()) return
        val next = (listOf(h) + history().filter { it != h }).take(MAX)
        prefs.edit().putString(KEY_HISTORY, next.joinToString("\n")).apply()
    }

    /** Remove a host from the history (the dialog's delete button). */
    fun remove(host: String) {
        val next = history().filter { it != host.trim() }
        prefs.edit().putString(KEY_HISTORY, next.joinToString("\n")).apply()
    }

    companion object {
        private const val KEY_HISTORY = "history"
        const val MAX = 5
    }
}
