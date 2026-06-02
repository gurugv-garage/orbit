package dev.orbit.dock.llm

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The dock's tool **schemas + catalogs** — the JSON the model sees and the valid
 * value sets — with NO execution. Single source of truth shared by `:app` (whose
 * `DockToolsAdapter` wraps these with real servo/face execution) and `:bench`
 * (which wraps them with no-op tools to measure model behavior on the *real*
 * tool surface). Keeping the schema here means a change to the dock's tools is
 * automatically what the benchmark tests — no drift.
 *
 * Catalogs ([VALID], [FACES], [GESTURES]) live here too because both the schema
 * `enum`s and the execution-time validation derive from them.
 */
object DockToolSchemas {

    /** Catalog of valid (part → states). Mirrors v0 firmware + states.json. */
    val VALID: Map<String, List<String>> = mapOf(
        "neck" to listOf("lookUp", "lookDown", "center"),
        "foot" to listOf("forward", "left", "right"),
    )

    val FACES: List<String> = listOf(
        "neutral", "happy", "curious", "concerned", "surprised", "sad", "excited", "angry", "love",
    )

    /** Named gestures → DockTools sequence strings (`part:state; wait:ms; …`). */
    val GESTURES: Map<String, String> = mapOf(
        "nod" to "neck:lookDown; neck:center; neck:lookDown; neck:center",
        "shake_head" to "foot:left; foot:right; foot:left; foot:forward",
        "wiggle" to "foot:left; foot:right; foot:left; foot:right; foot:forward",
        "look_around" to "foot:left; wait:400; foot:right; wait:400; foot:forward",
        "look_up" to "neck:lookUp",
        "look_down" to "neck:lookDown",
    )

    private val MOVE_STATES: List<String> = VALID.values.flatten().distinct()

    val setFace: JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            putJsonObject("expression") {
                put("type", "string"); put("description", "the mood to show")
                putJsonArray("enum") { FACES.forEach { add(it) } }
            }
        }
        putJsonArray("required") { add("expression") }
    }

    val moveBody: JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            putJsonObject("part") {
                put("type", "string"); put("description", "which part")
                putJsonArray("enum") { add("neck"); add("foot") }
            }
            putJsonObject("state") {
                put("type", "string"); put("description", "target position")
                putJsonArray("enum") { MOVE_STATES.forEach { add(it) } }
            }
        }
        putJsonArray("required") { add("part"); add("state") }
    }

    val gesture: JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            putJsonObject("name") {
                put("type", "string"); put("description", "which gesture")
                putJsonArray("enum") { GESTURES.keys.forEach { add(it) } }
            }
        }
        putJsonArray("required") { add("name") }
    }

    val moveSequence: JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            putJsonObject("steps") {
                put("type", "array")
                put("description", "ordered list of moves")
                putJsonObject("items") {
                    put("type", "object")
                    putJsonObject("properties") {
                        putJsonObject("part") {
                            put("type", "string"); putJsonArray("enum") { add("neck"); add("foot") }
                        }
                        putJsonObject("state") {
                            put("type", "string")
                            putJsonArray("enum") { MOVE_STATES.forEach { add(it) } }
                        }
                        putJsonObject("wait_ms") {
                            put("type", "integer"); put("description", "pause after this move, 0-5000")
                        }
                    }
                    putJsonArray("required") { add("part"); add("state") }
                }
            }
        }
        putJsonArray("required") { add("steps") }
    }

    /** compute: a SAFE evaluator for arithmetic + random numbers + simple
     *  comparisons — the dock's stand-in for "run code". Models reach for a code
     *  tool on "pick a random number, if >5 say hi" (gemini emitted a run_code
     *  call that didn't exist and gave up); this gives them a real, bounded one.
     *  It does NOT run general code — just numbers/operators/`random(a,b)`. */
    val compute: JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            putJsonObject("expression") {
                put("type", "string")
                put("description", "an arithmetic/comparison expression, e.g. \"3+4*2\", \"random(1,10)\", \"random(1,10) > 5\"")
            }
        }
        putJsonArray("required") { add("expression") }
    }

    // Descriptions live next to the schemas so the model-facing surface is one place.
    const val COMPUTE_DESC = "Evaluate a SAFE arithmetic or random-number expression and get the result back " +
        "(e.g. math, or \"random(1,10)\", or \"random(1,10) > 5\"). Use this whenever you'd otherwise want to " +
        "\"run code\" for a number or a calculation — you have NO general code execution, only this."
    const val SET_FACE_DESC = "Set the dock's facial expression to match the mood of what you're saying."
    const val MOVE_BODY_DESC = "Move one of the dock's body parts. neck: lookUp/lookDown/center. foot: left/right/forward."
    const val GESTURE_DESC = "Perform a whole gesture (nod, shake head, wiggle, look around)."
    const val MOVE_SEQUENCE_DESC = "Perform a custom sequence of body moves you compose yourself — " +
        "for expressive or repeated motion. Each step is a part + state, with an " +
        "optional pause (wait_ms) before the next."
}
