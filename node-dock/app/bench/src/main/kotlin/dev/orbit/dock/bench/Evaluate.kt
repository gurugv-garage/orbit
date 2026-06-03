package dev.orbit.dock.bench

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject

/** Outcome of one run before aggregation. */
data class TurnOutcome(
    val output: String,
    val toolCalls: List<ToolCallRecord>,
    val allEnumsValid: Boolean,
    val firstEventMs: Long,
    val totalMs: Long,
    val error: String? = null,
)

/**
 * Maps a [Case]'s [Expect] to a pass/fail. ALL present predicate fields must
 * hold. Keep this dumb + transparent: the benchmark's credibility is that you
 * can read exactly why a run passed.
 */
object Evaluate {

    /** Body-movement tool — set_face is expressive, not movement. */
    private val MOVE_TOOLS = setOf("move")

    fun pass(expect: Expect, o: TurnOutcome): Boolean {
        if (o.error != null) return false
        val text = o.output.trim()
        val tools = o.toolCalls

        expect.tool?.let { if (it == "any" && tools.isEmpty()) return false }
        expect.toolName?.let { want -> if (tools.none { it.name == want }) return false }
        expect.minToolCalls?.let { if (tools.size < it) return false }
        expect.noTool?.let { if (it && tools.isNotEmpty()) return false }
        expect.noMove?.let { if (it && tools.any { tc -> tc.name in MOVE_TOOLS }) return false }
        expect.nonEmptySpeech?.let { if (it && text.isEmpty()) return false }
        expect.minSpeechChars?.let { if (text.length < it) return false }
        expect.validEnums?.let { if (it && !o.allEnumsValid) return false }
        expect.keywords?.let { kws ->
            val hay = text.lowercase()
            if (kws.none { hay.contains(it.lowercase()) }) return false
        }
        expect.degRange?.let { r ->
            // any move step on r.part whose degrees ∈ [lo, hi]
            val ok = tools.filter { it.name == "move" }.any { tc ->
                moveSteps(tc.args).any { (part, deg) -> part == r.part && deg != null && deg in r.lo..r.hi }
            }
            if (!ok) return false
        }
        expect.minSteps?.let { n ->
            val steps = tools.filter { it.name == "move" }.maxOfOrNull { moveStepCount(it.args) } ?: 0
            if (steps < n) return false
        }
        expect.maxSteps?.let { n ->
            val steps = tools.filter { it.name == "move" }.maxOfOrNull { moveStepCount(it.args) } ?: 0
            if (steps > n) return false
        }
        expect.durRange?.let { r ->
            val ok = tools.filter { it.name == "move" }.any { tc ->
                moveDurations(tc.args).any { it in r.lo..r.hi }
            }
            if (!ok) return false
        }
        return true
    }

    /** Parse a `move` call's args into (part, degrees) pairs, in order. */
    private fun moveSteps(args: String): List<Pair<String?, Double?>> {
        // matches each step object's part + degrees, tolerant of key order.
        return Regex("\\{[^{}]*?\\}").findAll(args).mapNotNull { m ->
            val o = m.value
            val part = Regex("\"part\"\\s*:\\s*\"(\\w+)\"").find(o)?.groupValues?.get(1)
            val deg = Regex("\"degrees\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)").find(o)?.groupValues?.get(1)?.toDoubleOrNull()
            if (part == null && deg == null) null else part to deg
        }.toList()
    }

    /** All duration_ms values across a `move` call's steps. */
    private fun moveDurations(args: String): List<Int> =
        Regex("\"duration_ms\"\\s*:\\s*(\\d+)").findAll(args).mapNotNull { it.groupValues[1].toIntOrNull() }.toList()

    private val lenientJson = Json { isLenient = true; ignoreUnknownKeys = true }

    /** Count of TOP-LEVEL steps in the `steps` array (a multi-joint `parts` step
     *  counts as ONE step, not one-per-joint). Falls back to 0 on parse failure. */
    private fun moveStepCount(args: String): Int = runCatching {
        (lenientJson.parseToJsonElement(args).jsonObject["steps"] as? JsonArray)?.size ?: 0
    }.getOrDefault(0)

    /** Per-run objective signals, surfaced in the viewer (not all gate the pass). */
    fun objective(o: TurnOutcome): Map<String, Boolean> = mapOf(
        "toolCalled" to o.toolCalls.isNotEmpty(),
        "enumsValid" to o.allEnumsValid,
        "spoke" to o.output.isNotBlank(),
    )
}
