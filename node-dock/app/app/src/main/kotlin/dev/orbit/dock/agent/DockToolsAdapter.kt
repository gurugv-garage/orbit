package dev.orbit.dock.agent

import dev.orbit.dock.llm.DockToolSchemas
import dev.pi.agent.AgentTool
import dev.pi.agent.AgentToolResult
import dev.pi.agent.AgentToolUpdateCallback
import dev.pi.ai.TextContent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Exposes the dock's physical/expressive actions to the agent loop as
 * `AgentTool`s. The model emits `tool_calls`; the loop runs these; results are
 * fed back so the model can react (UX.md capability 2).
 *
 * Both tools:
 *  - use **enum-constrained** params (a small model invents invalid values
 *    otherwise — glm/gemma emitted `head`/`up` without enums), and
 *  - return a short result the model can narrate around, never raw JSON, and
 *  - are **fire-and-forget** physically — `DockTools` runs servo travel in its
 *    own scope, so streamed speech is never blocked (talk-while-moving).
 *
 * [statusPhrase] maps a call to a human label for the live per-action status
 * (UX.md capability 3): `move_body{neck,lookUp}` → "looking up".
 */
object DockToolsAdapter {

    // Schemas + catalogs (enum value sets, valid part↔state pairs, gestures) live
    // in :dock-llm's [DockToolSchemas] so the live dock and the :bench harness
    // test exactly the same tool surface. This adapter adds Android execution.
    private val VALID = DockToolSchemas.VALID
    private val FACES = DockToolSchemas.FACES
    private val GESTURES = DockToolSchemas.GESTURES

    fun tools(dock: DockTools): List<AgentTool> =
        listOf(SetFaceTool(dock), MoveBodyTool(dock), GestureTool(dock), MoveSequenceTool(dock), ComputeTool())

    /** Human phrase for the live status line, e.g. "looking left", "smiling". */
    fun statusPhrase(toolName: String, args: JsonObject): String {
        fun s(k: String) = args[k]?.jsonPrimitive?.content.orEmpty()
        return when (toolName) {
            "set_face" -> when (s("expression")) {
                "happy", "excited", "love" -> "smiling"
                "sad", "concerned" -> "frowning"
                "surprised" -> "surprised"
                "curious" -> "tilting"
                else -> "expression"
            }
            "move_body" -> when (s("part") to s("state")) {
                "neck" to "lookUp" -> "looking up"
                "neck" to "lookDown" -> "looking down"
                "neck" to "center" -> "centering"
                "foot" to "left" -> "turning left"
                "foot" to "right" -> "turning right"
                "foot" to "forward" -> "facing forward"
                else -> "moving"
            }
            "gesture" -> when (s("name")) {
                "nod" -> "nodding"
                "shake_head" -> "shaking head"
                "wiggle" -> "wiggling"
                "look_around" -> "looking around"
                "look_up" -> "looking up"
                "look_down" -> "looking down"
                else -> "gesturing"
            }
            "move_sequence" -> "moving"
            "compute" -> "thinking"
            else -> toolName
        }
    }

    // ── tools ─────────────────────────────────────────────────────────────

    private class SetFaceTool(private val dock: DockTools) : AgentTool(
        name = "set_face",
        description = DockToolSchemas.SET_FACE_DESC,
        parameters = DockToolSchemas.setFace,
    ) {
        override suspend fun execute(id: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            val expr = params["expression"]?.jsonPrimitive?.content.orEmpty()
            val r = dock.setFace(expr)            // returns "ok" or "unknown expression: …"
            return AgentToolResult(listOf(TextContent(r)), details = mapOf("expression" to expr))
        }
    }

    private class MoveBodyTool(private val dock: DockTools) : AgentTool(
        name = "move_body",
        description = DockToolSchemas.MOVE_BODY_DESC,
        parameters = DockToolSchemas.moveBody,
    ) {
        override suspend fun execute(id: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            val part = params["part"]?.jsonPrimitive?.content.orEmpty()
            val state = params["state"]?.jsonPrimitive?.content.orEmpty()
            // Reject valid-enum-but-mismatched pairs (e.g. neck,left) BEFORE the
            // body call, so the model gets a clear correction it can react to.
            if (state !in (VALID[part] ?: emptyList())) {
                val ok = VALID[part]?.joinToString(", ") ?: "—"
                return AgentToolResult(
                    listOf(TextContent("can't: $part has no '$state'. $part supports: $ok")),
                    details = mapOf("error" to "bad_pair", "part" to part, "state" to state),
                )
            }
            // Fire-and-forget via the existing validated sequencer (talk-while-move).
            val r = dock.makeBodyMovements("$part:$state")   // "ok — running 1 moves" | "no body connected…"
            return AgentToolResult(listOf(TextContent(r)), details = mapOf("part" to part, "state" to state))
        }
    }

    /**
     * Named gestures as a single verb — the way a model naturally expresses
     * "nod"/"wiggle"/"look around". Each expands to a validated multi-step
     * [GESTURES] sequence run by the same fire-and-forget sequencer (so it runs
     * in parallel with speech). This is the fix for small models reaching for a
     * single invalid state (`nodYes`) instead of chaining moves themselves.
     */
    private class GestureTool(private val dock: DockTools) : AgentTool(
        name = "gesture",
        description = DockToolSchemas.GESTURE_DESC,
        parameters = DockToolSchemas.gesture,
    ) {
        override suspend fun execute(id: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            val name = params["name"]?.jsonPrimitive?.content.orEmpty()
            val seq = GESTURES[name]
                ?: return AgentToolResult(
                    listOf(TextContent("unknown gesture '$name'. options: ${GESTURES.keys.joinToString(", ")}")),
                    details = mapOf("error" to "unknown_gesture", "name" to name),
                )
            val r = dock.makeBodyMovements(seq)
            return AgentToolResult(listOf(TextContent(r)), details = mapOf("gesture" to name))
        }
    }

    /**
     * Arbitrary model-authored motion: the model composes its OWN sequence of
     * steps (part+state, optional wait between), so it can express anything —
     * "nod twice slowly", "look left, pause, then down" — not just the named
     * [GESTURES]. This is the expressive path; gestures are reliable shortcuts.
     *
     * Each step is validated against the catalog; invalid pairs are reported (the
     * whole sequence still runs the valid steps, and the model reads the issues
     * and can adjust) — same validate-and-react pattern as [MoveBodyTool].
     */
    private class MoveSequenceTool(private val dock: DockTools) : AgentTool(
        name = "move_sequence",
        description = DockToolSchemas.MOVE_SEQUENCE_DESC,
        parameters = DockToolSchemas.moveSequence,
    ) {
        override suspend fun execute(id: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            val steps = params["steps"] as? kotlinx.serialization.json.JsonArray
                ?: return AgentToolResult(
                    listOf(TextContent("move_sequence needs a 'steps' array")),
                    details = mapOf("error" to "no_steps"),
                )
            val parts = mutableListOf<String>()
            val problems = mutableListOf<String>()
            for ((i, el) in steps.withIndex()) {
                val o = el as? JsonObject ?: continue
                val part = o["part"]?.jsonPrimitive?.content.orEmpty()
                val state = o["state"]?.jsonPrimitive?.content.orEmpty()
                val wait = o["wait_ms"]?.jsonPrimitive?.content?.toLongOrNull()
                if (state !in (VALID[part] ?: emptyList())) {
                    problems.add("step ${i + 1}: $part has no '$state'")
                    continue
                }
                parts.add("$part:$state")
                if (wait != null && wait > 0) parts.add("wait:${wait.coerceAtMost(5000)}")
            }
            if (parts.isEmpty()) {
                return AgentToolResult(
                    listOf(TextContent("no valid steps. neck: ${VALID["neck"]}; foot: ${VALID["foot"]}. issues: ${problems.joinToString()}")),
                    details = mapOf("error" to "all_invalid"),
                )
            }
            val r = dock.makeBodyMovements(parts.joinToString("; "))
            val msg = if (problems.isEmpty()) r else "$r (skipped: ${problems.joinToString()})"
            return AgentToolResult(listOf(TextContent(msg)), details = mapOf("steps" to parts.size))
        }
    }

    /**
     * Safe compute — the dock's bounded stand-in for "run code". Lets the model
     * actually do "pick a random number, if >5 say hi" instead of calling a
     * non-existent run_code tool and giving up (observed live with gemini). No
     * hardware, no general code — just [SafeCompute] (math / random / compare).
     */
    private class ComputeTool : AgentTool(
        name = "compute",
        description = DockToolSchemas.COMPUTE_DESC,
        parameters = DockToolSchemas.compute,
    ) {
        private val engine = dev.orbit.dock.llm.SafeCompute()
        override suspend fun execute(toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            val expr = params["expression"]?.jsonPrimitive?.content.orEmpty()
            val result = engine.eval(expr)
            return AgentToolResult(listOf(TextContent(result)), details = mapOf("expression" to expr, "result" to result))
        }
    }
}
