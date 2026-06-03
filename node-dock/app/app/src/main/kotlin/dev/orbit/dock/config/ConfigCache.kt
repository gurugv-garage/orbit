package dev.orbit.dock.config

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import timber.log.Timber
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The dock's local view of orbit-station config. Three layers, highest wins:
 *
 *   1. in-memory synced values (from station pushes this session)
 *   2. SharedPreferences (synced values persisted across reboots)
 *   3. baked asset `config-defaults.json` (packed at build time from the
 *      station's current config — so the dock works with NO station ever seen)
 *
 * A station push carries a `lastUpdated`; we apply it only if it's NEWER than
 * what we hold, then persist and fire onChange listeners. This is the "update
 * + cache, with an onChange callback" the dock wires its features to.
 *
 * Keys are addressed `scope.key` (e.g. "dock.faceGestures"). Values are stored
 * as their JSON text so any type (number/boolean/string/object) round-trips.
 * Never throws on read — a missing/un-parseable value falls through to the next
 * layer, ultimately to the caller's supplied fallback.
 *
 * The app declares which keys it cares about in [DOCK_KEYS]; pushes for other
 * keys are ignored (the ESP32 has its own interest list firmware-side).
 */
class ConfigCache(context: Context) {
    private val appCtx = context.applicationContext
    private val prefs: SharedPreferences =
        appCtx.getSharedPreferences("orbit_config", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** scope.key → raw JSON text of the current synced value. */
    private val mem = ConcurrentHashMap<String, String>()
    /** scope.key → lastUpdated of the value we hold (synced layer only). */
    private val stamps = ConcurrentHashMap<String, Long>()
    /** scope.key → baked default JSON text (from the asset). */
    private val baked = ConcurrentHashMap<String, String>()

    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

    init {
        loadBaked()
        loadPersisted()
    }

    /** Register a callback fired (with "scope.key") whenever a key changes. */
    fun onChange(listener: (String) -> Unit) { listeners.add(listener) }

    /**
     * Apply a station push/snapshot for one key. Returns true if it changed our
     * value (newer lastUpdated). Stale pushes (older/equal stamp) are ignored so
     * out-of-order frames or a re-announce can't roll us back.
     */
    fun apply(scope: String, key: String, value: JsonElement, lastUpdated: Long): Boolean {
        val id = "$scope.$key"
        val have = stamps[id] ?: -1L
        if (lastUpdated <= have && mem.containsKey(id)) return false
        val text = value.toString()
        mem[id] = text
        stamps[id] = lastUpdated
        prefs.edit()
            .putString("v:$id", text)
            .putLong("t:$id", lastUpdated)
            .apply()
        Timber.i("config: applied $id (lastUpdated=$lastUpdated)")
        listeners.forEach { runCatching { it(id) } }
        return true
    }

    // ── typed reads (synced → persisted → baked → fallback) ──────────────────

    fun raw(scope: String, key: String): String? = mem["$scope.$key"] ?: baked["$scope.$key"]

    fun string(scope: String, key: String, fallback: String): String =
        raw(scope, key)?.let { runCatching { json.parseToJsonElement(it).toString().trim('"') }.getOrNull() } ?: fallback

    /** Read an object-valued key (e.g. faceGestures) as a JsonObject, or null. */
    fun obj(scope: String, key: String): JsonObject? =
        raw(scope, key)?.let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }

    private fun loadBaked() {
        val text = try {
            appCtx.assets.open(BAKED_ASSET).bufferedReader().use { it.readText() }
        } catch (t: Throwable) {
            Timber.w("config: no $BAKED_ASSET baked — relying on station + code fallbacks")
            return
        }
        // shape: { scope: { key: value, ... }, ... }
        runCatching {
            for ((scope, entries) in json.parseToJsonElement(text).jsonObject) {
                for ((key, value) in entries.jsonObject) baked["$scope.$key"] = value.toString()
            }
        }.onFailure { Timber.w(it, "config: failed to parse $BAKED_ASSET") }
        Timber.i("config: baked ${baked.size} default keys from $BAKED_ASSET")
    }

    private fun loadPersisted() {
        for ((k, v) in prefs.all) {
            if (k.startsWith("v:") && v is String) mem[k.removePrefix("v:")] = v
            if (k.startsWith("t:") && v is Long) stamps[k.removePrefix("t:")] = v
        }
        if (mem.isNotEmpty()) Timber.i("config: restored ${mem.size} synced keys from prefs")
    }

    companion object {
        const val BAKED_ASSET = "config-defaults.json"
        /** Keys the dock app listens for; other scopes' pushes are ignored. */
        val DOCK_KEYS = setOf(
            "dock.faceGestures", "dock.idleAnimations", "dock.gazeTracking",
            "dock.ttsRate", "dock.cameraDefaultOn", "dock.thinkingLevel",
        )
    }
}
