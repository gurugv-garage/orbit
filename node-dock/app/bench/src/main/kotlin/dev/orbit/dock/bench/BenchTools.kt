package dev.orbit.dock.bench

import dev.orbit.dock.llm.DockToolSchemas
import dev.pi.agent.AgentTool
import dev.pi.agent.AgentToolResult
import dev.pi.agent.AgentToolUpdateCallback
import dev.pi.ai.TextContent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The dock's four tools wired with NO-OP execution — same schemas + descriptions
 * as the live dock ([DockToolSchemas]), and the SAME validation feedback (reject
 * bad part↔state pairs, expand/validate sequences) so a model can react to a
 * rejection exactly as it does on the real dock. We record every call but never
 * touch a servo or face. This isolates MODEL behavior (does it call the right
 * tool with valid args?) from Android side-effects.
 *
 * The tool *results* fed back to the model mirror the live `DockTools` strings
 * ("ok …" / "can't: …"), so multi-step react-to-result cases behave faithfully.
 */
class BenchTools {
    /** Every tool call the model made this turn (across the whole agent loop). */
    val calls = mutableListOf<ToolCallRecord>()
    /** True if any move/gesture/sequence call used only valid part↔state pairs. */
    var allEnumsValid = true
        private set

    private val VALID = DockToolSchemas.VALID
    private val GESTURES = DockToolSchemas.GESTURES

    fun reset() { calls.clear(); allEnumsValid = true }

    fun tools(): List<AgentTool> = listOf(SetFace(), MoveBody(), Gesture(), MoveSequence(), Compute())

    private val compute = dev.orbit.dock.llm.SafeCompute()

    private fun record(name: String, params: JsonObject) =
        calls.add(ToolCallRecord(name, params.toString()))

    private inner class SetFace : AgentTool("set_face", DockToolSchemas.SET_FACE_DESC, DockToolSchemas.setFace) {
        override suspend fun execute(toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            record(name, params)
            val expr = params["expression"]?.jsonPrimitive?.content.orEmpty()
            val ok = expr in DockToolSchemas.FACES
            if (!ok) allEnumsValid = false
            return AgentToolResult(
                listOf(TextContent(if (ok) "ok" else "unknown expression: $expr")),
                details = mapOf("expression" to expr),
            )
        }
    }

    private inner class MoveBody : AgentTool("move_body", DockToolSchemas.MOVE_BODY_DESC, DockToolSchemas.moveBody) {
        override suspend fun execute(toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            record(name, params)
            val part = params["part"]?.jsonPrimitive?.content.orEmpty()
            val state = params["state"]?.jsonPrimitive?.content.orEmpty()
            if (state !in (VALID[part] ?: emptyList())) {
                allEnumsValid = false
                val okStates = VALID[part]?.joinToString(", ") ?: "—"
                return AgentToolResult(
                    listOf(TextContent("can't: $part has no '$state'. $part supports: $okStates")),
                    details = mapOf("error" to "bad_pair"),
                )
            }
            return AgentToolResult(listOf(TextContent("ok — running 1 moves")), details = mapOf("part" to part, "state" to state))
        }
    }

    private inner class Gesture : AgentTool("gesture", DockToolSchemas.GESTURE_DESC, DockToolSchemas.gesture) {
        override suspend fun execute(toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            record(name, params)
            val g = params["name"]?.jsonPrimitive?.content.orEmpty()
            val seq = GESTURES[g] ?: run {
                allEnumsValid = false
                return AgentToolResult(
                    listOf(TextContent("unknown gesture '$g'. options: ${GESTURES.keys.joinToString(", ")}")),
                    details = mapOf("error" to "unknown_gesture"),
                )
            }
            return AgentToolResult(listOf(TextContent("ok — running gesture $g ($seq)")), details = mapOf("gesture" to g))
        }
    }

    private inner class MoveSequence : AgentTool("move_sequence", DockToolSchemas.MOVE_SEQUENCE_DESC, DockToolSchemas.moveSequence) {
        override suspend fun execute(toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            record(name, params)
            val steps = params["steps"] as? JsonArray
                ?: return AgentToolResult(listOf(TextContent("move_sequence needs a 'steps' array")), details = mapOf("error" to "no_steps"))
            val good = mutableListOf<String>()
            val problems = mutableListOf<String>()
            for ((i, el) in steps.withIndex()) {
                val o = el as? JsonObject ?: continue
                val part = o["part"]?.jsonPrimitive?.content.orEmpty()
                val state = o["state"]?.jsonPrimitive?.content.orEmpty()
                if (state !in (VALID[part] ?: emptyList())) { problems.add("step ${i + 1}: $part has no '$state'"); continue }
                good.add("$part:$state")
            }
            if (problems.isNotEmpty()) allEnumsValid = false
            if (good.isEmpty()) return AgentToolResult(
                listOf(TextContent("no valid steps. issues: ${problems.joinToString()}")),
                details = mapOf("error" to "all_invalid"),
            )
            val msg = "ok — running ${good.size} moves" + if (problems.isEmpty()) "" else " (skipped: ${problems.joinToString()})"
            return AgentToolResult(listOf(TextContent(msg)), details = mapOf("steps" to good.size))
        }
    }

    private inner class Compute : AgentTool("compute", DockToolSchemas.COMPUTE_DESC, DockToolSchemas.compute) {
        override suspend fun execute(toolCallId: String, params: JsonObject, onUpdate: AgentToolUpdateCallback?): AgentToolResult<Any?> {
            record(name, params)
            val result = compute.eval(params["expression"]?.jsonPrimitive?.content.orEmpty())
            return AgentToolResult(listOf(TextContent(result)), details = mapOf("result" to result))
        }
    }
}
