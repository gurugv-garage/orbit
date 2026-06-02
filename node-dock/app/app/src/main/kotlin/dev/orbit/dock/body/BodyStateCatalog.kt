package dev.orbit.dock.body

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import timber.log.Timber
import java.io.File

/**
 * Brain-side state catalog. Loaded once at startup from
 *   - app/src/main/assets/states.json                  (default, shipped)
 *   - <context.filesDir>/states-override.json          (writable, optional)
 *
 * Override entries take precedence per-(part, state). The catalog is validated
 * against the body's BodyProfile when the profile arrives: states naming
 * unknown parts are dropped with a warning; param values outside the body's
 * declared range are clipped (with a warning) at lookup time, not at load.
 *
 * A "state" is a primitive command bundle: `{ paramName: value }`. The brain
 * packs the bundle into `body.parts[<part>]` of a `set_target` envelope.
 *
 * Schema versioning: `version = "1"` for now; future bumps will be
 * additive-only or paired with a migration step.
 */
class BodyStateCatalog(
    private val entries: Map<String, PartCatalog>,
) {
    data class PartCatalog(
        val home: String?,
        val states: Map<String, PrimitiveCommand>,
    )

    data class PrimitiveCommand(
        val params: Map<String, Double>,
        val durationMs: Int,
    )

    /** Catalog entry for (part, state) — null if unknown. */
    fun resolve(part: String, stateName: String): PrimitiveCommand? =
        entries[part]?.states?.get(stateName)

    /** Names of states defined for a given part. */
    fun statesOf(part: String): List<String> =
        entries[part]?.states?.keys?.toList().orEmpty()

    /** All parts the catalog knows about. */
    val parts: Set<String> get() = entries.keys

    /** Default/home state for a part, if declared. */
    fun homeOf(part: String): String? = entries[part]?.home

    /**
     * Validate against the body's profile. Returns a new catalog with:
     *   - entries for parts the body doesn't expose dropped
     *   - param values clipped to declared range
     *   - params unknown to the body removed (with a warning)
     */
    fun validatedAgainst(profile: BodyProfile): BodyStateCatalog {
        val out = mutableMapOf<String, PartCatalog>()
        for ((partName, partCat) in entries) {
            val partCap = profile.parts[partName]
            if (partCap == null) {
                Timber.w("catalog: dropping part '$partName' — body does not expose it")
                continue
            }
            val cleanedStates = mutableMapOf<String, PrimitiveCommand>()
            for ((stateName, cmd) in partCat.states) {
                val cleanedParams = mutableMapOf<String, Double>()
                for ((paramName, value) in cmd.params) {
                    if (paramName !in partCap.params) {
                        Timber.w("catalog: part '$partName' state '$stateName' references unknown param '$paramName' — dropped")
                        continue
                    }
                    val (clamped, clipped) = partCap.clamp(paramName, value)
                    if (clipped) {
                        Timber.w("catalog: $partName.$stateName.$paramName=$value clipped to $clamped")
                    }
                    cleanedParams[paramName] = clamped
                }
                cleanedStates[stateName] = PrimitiveCommand(cleanedParams, cmd.durationMs)
            }
            out[partName] = PartCatalog(home = partCat.home, states = cleanedStates)
        }
        Timber.i("catalog validated: ${out.keys.joinToString()} (${out.values.sumOf { it.states.size }} states total)")
        return BodyStateCatalog(out)
    }

    companion object {
        private const val ASSET = "states.json"
        private const val OVERRIDE = "states-override.json"
        private val JSON = Json { ignoreUnknownKeys = true; isLenient = true }
        private const val DURATION_KEY = "duration_ms"

        /** Load from app assets + optional override file. Never throws — falls back to empty catalog. */
        fun load(ctx: Context): BodyStateCatalog {
            val base = try {
                ctx.assets.open(ASSET).bufferedReader().use { it.readText() }
            } catch (t: Throwable) {
                Timber.w(t, "catalog: failed to read $ASSET asset — falling back to empty")
                return BodyStateCatalog(emptyMap())
            }
            val baseMap = parse(base) ?: return BodyStateCatalog(emptyMap())

            val overrideFile = File(ctx.filesDir, OVERRIDE)
            val overlay = if (overrideFile.exists()) {
                try {
                    parse(overrideFile.readText()) ?: emptyMap()
                } catch (t: Throwable) {
                    Timber.w(t, "catalog: failed to parse $OVERRIDE — ignored")
                    emptyMap()
                }
            } else emptyMap()

            // Overlay: per-(part, state) override wins; per-part `home` override wins if present.
            val merged = mutableMapOf<String, PartCatalog>()
            for (k in (baseMap.keys + overlay.keys)) {
                val b = baseMap[k]
                val o = overlay[k]
                val home = o?.home ?: b?.home
                val states = mutableMapOf<String, PrimitiveCommand>()
                b?.states?.let { states.putAll(it) }
                o?.states?.let { states.putAll(it) }
                merged[k] = PartCatalog(home, states)
            }
            Timber.i("catalog loaded: ${merged.keys.joinToString()} (${merged.values.sumOf { it.states.size }} states; override=${overrideFile.exists()})")
            return BodyStateCatalog(merged)
        }

        private fun parse(text: String): Map<String, PartCatalog>? {
            val root = try {
                JSON.parseToJsonElement(text).jsonObject
            } catch (t: Throwable) {
                Timber.w(t, "catalog: parse failed")
                return null
            }
            val partsObj = root["parts"] as? JsonObject ?: return emptyMap()
            val out = mutableMapOf<String, PartCatalog>()
            for ((partName, partEl) in partsObj) {
                val partObj = partEl as? JsonObject ?: continue
                val home = (partObj["home"] as? JsonPrimitive)?.content
                val statesObj = partObj["states"] as? JsonObject ?: continue
                val states = mutableMapOf<String, PrimitiveCommand>()
                for ((stateName, stateEl) in statesObj) {
                    val stateObj = stateEl as? JsonObject ?: continue
                    var duration = 400
                    val params = mutableMapOf<String, Double>()
                    for ((k, v) in stateObj) {
                        val prim = v as? JsonPrimitive ?: continue
                        if (k == DURATION_KEY) {
                            duration = prim.intOrNull ?: prim.doubleOrNull?.toInt() ?: 400
                        } else {
                            val d = prim.doubleOrNull ?: continue
                            params[k] = d
                        }
                    }
                    states[stateName] = PrimitiveCommand(params, duration)
                }
                out[partName] = PartCatalog(home, states)
            }
            return out
        }
    }
}
