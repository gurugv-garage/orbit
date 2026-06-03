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

    /**
     * The degree↔µs scale is FIXED and universal for every part:
     *   -90° = 500µs, 0° = 1500µs, +90° = 2500µs  (1° ≈ 11.11µs).
     * A given degree is the same physical servo angle everywhere — it never
     * rescales per part.
     */
    private const val FULL_SWING_DEG = 90.0

    /**
     * Per-part LIMIT on how far the LLM may command, in degrees from neutral.
     * This does NOT change the scale above — it just restricts the allowed range
     * (and clamps anything beyond). Mirror in the station console:
     * orbit-station/web/src/lib/bodyAngles.ts — keep both in sync.
     *
     * Both joints are MG90S. The FOOT is a direct 1:1 swivel → full ±90°. The
     * NECK runs through a semicircle sector-gear pair, so its real head tilt is
     * mechanically limited; set to ±45° (calibrated on hardware). To widen/narrow
     * a part, change ONLY its number here — the µs math is untouched.
     */
    val DEGREE_RANGE: Map<String, Double> = mapOf(
        "neck" to 45.0,
        "foot" to 90.0,
    )

    /**
     * Convert an absolute angle for a part to a servo pulse width (µs). The angle
     * is first clamped to the part's [DEGREE_RANGE] limit, then mapped on the
     * universal ±90° = 500–2500µs scale.
     */
    fun degreesToUs(part: String, degrees: Double): Int {
        val limit = DEGREE_RANGE[part] ?: FULL_SWING_DEG
        val clamped = degrees.coerceIn(-limit, limit)
        return (1500 + (clamped / FULL_SWING_DEG) * 1000).toInt().coerceIn(500, 2500)
    }

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

    /**
     * The ONE movement tool: an ordered sequence of steps the body performs.
     *
     * A step moves one or more joints AT THE SAME TIME, over `duration_ms`, then
     * pauses `wait_ms` before the next step. So:
     *   - SIMULTANEOUS (neck AND foot together) → put both in ONE step.
     *   - SEQUENTIAL (one then the next) → use separate steps.
     * A single move is a one-step, one-joint sequence.
     *
     * Each joint target is an absolute angle (degrees); the brain converts
     * °→µs per part. Two equivalent ways to give a step's joints:
     *   - one joint:  {part, degrees, ...}
     *   - many joints: {parts:[{part,degrees}, ...], ...}  ← moves all together
     */
    val move: JsonObject = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            putJsonObject("steps") {
                put("type", "array")
                put(
                    "description",
                    "Ordered steps, performed one after another. Each step moves its joint(s) " +
                        "SIMULTANEOUSLY. For 'neck and foot at the same time', list both in one step's " +
                        "`parts`. For 'do X then Y', use two steps.",
                )
                putJsonObject("items") {
                    put("type", "object")
                    putJsonObject("properties") {
                        // single-joint form
                        putJsonObject("part") {
                            put("type", "string")
                            put("description", "which joint (single-joint step). Use `parts` instead to move several at once.")
                            putJsonArray("enum") { add("neck"); add("foot") }
                        }
                        putJsonObject("degrees") {
                            put("type", "number")
                            put(
                                "description",
                                "Absolute target angle in degrees. 0 = neutral. " +
                                    "neck: -45 = fully up … 0 = level … +45 = fully down (range ±45°). " +
                                    "foot: -90 = fully left … 0 = forward … +90 = fully right (range ±90°). " +
                                    "'a little' ≈ a third of range, 'all the way' ≈ the limit. Out-of-range clamps.",
                            )
                        }
                        // multi-joint form: all move together within this step
                        putJsonObject("parts") {
                            put("type", "array")
                            put("description", "Several joints to move TOGETHER in this step (simultaneous). Use instead of part/degrees.")
                            putJsonObject("items") {
                                put("type", "object")
                                putJsonObject("properties") {
                                    putJsonObject("part") {
                                        put("type", "string"); putJsonArray("enum") { add("neck"); add("foot") }
                                    }
                                    putJsonObject("degrees") { put("type", "number"); put("description", "absolute angle for this joint") }
                                }
                                putJsonArray("required") { add("part"); add("degrees") }
                            }
                        }
                        putJsonObject("duration_ms") {
                            put("type", "integer")
                            put(
                                "description",
                                "Time for this step's joint(s) to reach target. 0 = snap, ~250 = quick, " +
                                    "~600 = normal, ~1500 = slow. Range 0–5000. Default ~400.",
                            )
                            put("minimum", 0); put("maximum", 5000)
                        }
                        putJsonObject("wait_ms") {
                            put("type", "integer")
                            put(
                                "description",
                                "Pause AFTER this step before the next, in ms (0–5000). A step may be " +
                                    "wait-only ({wait_ms: 2000}, no part) — a pure pause between moves.",
                            )
                            put("minimum", 0); put("maximum", 5000)
                        }
                    }
                    // a step needs EITHER part+degrees OR parts; validated in code.
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
    const val MOVE_DESC = "Move the body. Give an ordered list of steps; each step moves its joint(s) to an " +
        "absolute angle in DEGREES over a duration, with an optional pause after. " +
        "The steps list can be ANY LENGTH — chain as many as the motion needs. " +
        "neck nods up/down (±45°, 0=level, negative=up). foot swivels left/right (±90°, 0=forward, negative=left). " +
        "SAME TIME (neck AND foot together): put both in ONE step's `parts`, e.g. " +
        "{parts:[{part:neck,degrees:-20},{part:foot,degrees:30}]}. ONE AFTER ANOTHER: use separate steps " +
        "(e.g. nod = neck +25 then 0; look around = foot -60 wait, foot +60 wait, foot 0). " +
        "REPEATING is just repeating the steps: 'nod 5 times' = the nod's steps listed 5 times in a row. " +
        "There is NO limit on how many times you repeat — just build the full sequence. " +
        "You choose the angle, speed (duration_ms) and beats (wait_ms)."
}
