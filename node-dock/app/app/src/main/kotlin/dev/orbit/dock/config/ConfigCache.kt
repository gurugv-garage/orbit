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
 * The dock's local view of orbit-station config. Config keys are FLAT/global
 * (no scope) — the same key can be shared by several components. Three layers,
 * highest wins:
 *
 *   1. in-memory synced values (from station pushes this session)
 *   2. SharedPreferences (synced values persisted across reboots)
 *   3. baked asset `config-defaults.json` (packed at build time from the
 *      station's current config — so the dock works with NO station ever seen)
 *
 * A station push carries `lastUpdated`; we apply it only if NEWER than what we
 * hold, then persist and fire onChange. The app declares the keys it cares
 * about in [INTEREST] (hardcoded here, its component init) and ANNOUNCES that
 * set to the station on connect; the station then pushes only those keys.
 *
 * Values are stored as JSON text so any type round-trips. Reads never throw —
 * a missing/unparseable value falls through to the next layer, then to the
 * caller's fallback.
 */
class ConfigCache(context: Context) {
    private val appCtx = context.applicationContext
    private val prefs: SharedPreferences =
        appCtx.getSharedPreferences("orbit_config", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val mem = ConcurrentHashMap<String, String>()      // key → synced JSON text
    private val stamps = ConcurrentHashMap<String, Long>()     // key → synced lastUpdated
    private val baked = ConcurrentHashMap<String, String>()    // key → baked default JSON text

    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

    init {
        loadBaked()
        loadPersisted()
    }

    /** Register a callback fired with the changed key whenever a key updates. */
    fun onChange(listener: (String) -> Unit) { listeners.add(listener) }

    /**
     * Apply a station push/snapshot for one key. Returns true if it changed our
     * value (newer lastUpdated). Stale/equal pushes are ignored so out-of-order
     * frames or a re-announce can't roll us back.
     */
    fun apply(key: String, value: JsonElement, lastUpdated: Long): Boolean {
        val have = stamps[key] ?: -1L
        if (lastUpdated <= have && mem.containsKey(key)) return false
        val text = value.toString()
        mem[key] = text
        stamps[key] = lastUpdated
        prefs.edit().putString("v:$key", text).putLong("t:$key", lastUpdated).apply()
        Timber.i("config: applied $key (lastUpdated=$lastUpdated)")
        listeners.forEach { runCatching { it(key) } }
        return true
    }

    // ── typed reads (synced → persisted → baked → fallback) ──────────────────

    fun raw(key: String): String? = mem[key] ?: baked[key]

    fun string(key: String, fallback: String): String =
        raw(key)?.let { runCatching { json.parseToJsonElement(it).toString().trim('"') }.getOrNull() } ?: fallback

    /** Read an object-valued key (e.g. faceGestures) as a JsonObject, or null. */
    fun obj(key: String): JsonObject? =
        raw(key)?.let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }

    private fun loadBaked() {
        val text = try {
            appCtx.assets.open(BAKED_ASSET).bufferedReader().use { it.readText() }
        } catch (t: Throwable) {
            Timber.w("config: no $BAKED_ASSET baked — relying on station + code fallbacks")
            return
        }
        // shape: flat { key: value, ... }
        runCatching {
            for ((key, value) in json.parseToJsonElement(text).jsonObject) baked[key] = value.toString()
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
        /** The flat keys the dock app (brain) is interested in — announced to the
         *  station on connect; the station pushes only these. */
        val INTEREST = listOf(
            "faceGestures", "bodyAddr", "idleAnimations", "gazeTracking",
            "ttsRate", "cameraDefaultOn", "thinkingLevel",
            "neckPitchLimitDeg", "footYawLimitDeg", "maxSpeedDegPerSec",
        )
    }
}
