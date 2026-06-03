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
    private val FACES = DockToolSchemas.FACES

    fun tools(dock: DockTools): List<AgentTool> =
        listOf(SetFaceTool(dock), MoveTool(dock), ComputeTool())

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
            "move" -> movePhrase(args)
            "compute" -> "thinking"
            else -> toolName
        }
    }

    /** Status phrase from the first step of a `move` call (e.g. "looking up"). */
    private fun movePhrase(args: JsonObject): String {
        val steps = args["steps"] as? kotlinx.serialization.json.JsonArray
        val multi = (steps?.size ?: 0) > 1
        val first = steps?.firstOrNull() as? JsonObject ?: return "moving"
        val part = first["part"]?.jsonPrimitive?.content
        val deg = first["degrees"]?.jsonPrimitive?.content?.toDoubleOrNull() ?: 0.0
        if (multi) return "moving"
        return when (part) {
            "neck" -> if (deg < -1) "looking up" else if (deg > 1) "looking down" else "centering"
            "foot" -> if (deg < -1) "turning left" else if (deg > 1) "turning right" else "facing forward"
            else -> "moving"
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

    /**
     * The ONE movement tool. The model gives an ordered list of steps; each step
     * turns a joint to an absolute angle in DEGREES over a duration, with an
     * optional pause after. A single move is a one-step list; complex motion
     * (nod, look-around, multi-phase expressions) is many steps. The brain
     * converts degrees → µs per part and runs the timed sequence fire-and-forget
     * (so it plays in parallel with speech). Validated above by the benchmark:
     * capable models compose correct individual + complex moves at 100%.
     */
    private class MoveTool(private val dock: DockTools) : AgentTool(
        name = "move",
        description = DockToolSchemas.MOVE_DESC,
        parameters = DockToolSchemas.move,
    ) {
        override suspend fun execute(id: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            val steps = params["steps"] as? kotlinx.serialization.json.JsonArray
                ?: return AgentToolResult(
                    listOf(TextContent("move needs a 'steps' array of {part, degrees, duration_ms?, wait_ms?}")),
                    details = mapOf("error" to "no_steps"),
                )
            val r = dock.makeMove(steps)   // converts °→µs, runs the timed sequence
            return AgentToolResult(listOf(TextContent(r)), details = mapOf("steps" to steps.size))
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
