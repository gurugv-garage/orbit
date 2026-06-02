package dev.orbit.dock.body

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.floatOrNull

/**
 * Application-facing BodyProfile. Mirrors the `profile` wire message but
 * unpacked into the typed shapes the dock UI + LLM tools consume.
 *
 * No named states here — the body only declares parts + primitive parameter
 * ranges + a home pose. Named states (lookUp, forward, ...) live brain-side
 * in BodyStateCatalog.
 */
data class BodyProfile(
    val deviceId: String,
    val name: String,
    val fwVersion: String,
    val parts: Map<String, PartCapabilityModel>,
) {
    /** Returns the list of param names the body declares for a part, or empty. */
    fun paramsOf(part: String): List<String> =
        parts[part]?.params?.keys?.toList().orEmpty()

    /** Lightweight prompt fragment describing the body's hardware to the LLM. */
    fun describeHardware(): String = buildString {
        appendLine("Body: $name ($deviceId, fw $fwVersion).")
        appendLine("Parts:")
        for ((pname, p) in parts) {
            appendLine("  • $pname — ${p.description}")
            for ((paramName, spec) in p.params) {
                val lo = spec.rangeLo?.toString() ?: "-∞"
                val hi = spec.rangeHi?.toString() ?: "+∞"
                appendLine("    - $paramName [$lo..$hi] ${spec.unit}")
            }
        }
    }.trimEnd()

    companion object {
        fun fromWire(body: ProfileBody): BodyProfile = BodyProfile(
            deviceId = body.deviceId,
            name = body.name,
            fwVersion = body.fwVersion,
            parts = body.parts.mapValues { (_, p) ->
                PartCapabilityModel(
                    description = p.description,
                    home = p.home.mapValues { (_, v) -> jsonNumberOrNull(v) ?: 0.0 },
                    params = p.params.mapValues { (_, spec) ->
                        val lo = spec.range.getOrNull(0)?.let { jsonNumberOrNull(it) }
                        val hi = spec.range.getOrNull(1)?.let { jsonNumberOrNull(it) }
                        ParamSpecModel(
                            type = spec.type,
                            unit = spec.unit,
                            rangeLo = lo,
                            rangeHi = hi,
                            default = spec.default?.let { jsonNumberOrNull(it) },
                            description = spec.description,
                        )
                    },
                )
            },
        )

        private fun jsonNumberOrNull(el: kotlinx.serialization.json.JsonElement): Double? {
            if (el !is JsonPrimitive) return null
            return el.floatOrNull?.toDouble()
        }
    }
}

data class PartCapabilityModel(
    val description: String,
    val home: Map<String, Double>,
    val params: Map<String, ParamSpecModel>,
) {
    /** Clamp `value` against this part's range for `param`. Returns (clamped, wasClipped). */
    fun clamp(param: String, value: Double): Pair<Double, Boolean> {
        val spec = params[param] ?: return value to false
        var v = value
        var clipped = false
        spec.rangeLo?.let { if (v < it) { v = it; clipped = true } }
        spec.rangeHi?.let { if (v > it) { v = it; clipped = true } }
        if (spec.type == "int") v = v.toLong().toDouble()
        return v to clipped
    }
}

data class ParamSpecModel(
    val type: String,
    val unit: String,
    val rangeLo: Double?,
    val rangeHi: Double?,
    val default: Double?,
    val description: String,
)
