package dev.orbit.dock.bench

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
            val maxSteps = tools.filter { it.name == "move" }.maxOfOrNull { moveSteps(it.args).size } ?: 0
            if (maxSteps < n) return false
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

    /** Per-run objective signals, surfaced in the viewer (not all gate the pass). */
    fun objective(o: TurnOutcome): Map<String, Boolean> = mapOf(
        "toolCalled" to o.toolCalls.isNotEmpty(),
        "enumsValid" to o.allEnumsValid,
        "spoke" to o.output.isNotBlank(),
    )
}
