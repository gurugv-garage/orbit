package dev.orbit.dock.agent

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Parses the station's `perception`/`recognize-result` frame into a
 * [RecognizeOutcome]. Pulled out of DockScreen so the wire-shape handling is
 * unit-tested ([RecognizeResultParserTest]) — a malformed or partial frame must
 * degrade to "unknown", never crash the screen's frame handler.
 *
 * Wire shape (orbit-station perception module):
 *   { reqId, name|null, tentative|null, confidence, noFace,
 *     people: [{name|null, tentative|null, confidence, side}] }
 *
 * `name` vs `tentative` IS the station's categorical verdict (confident vs
 * hedge band) — consumers act on these fields and must not re-threshold the
 * raw `confidence` float (display-only).
 */
object RecognizeResultParser {

    /** @return reqId (null when absent) + the parsed outcome. */
    fun parse(envelope: JsonObject): Pair<String?, RecognizeOutcome> {
        fun prim(o: JsonObject?, k: String): JsonPrimitive? = o?.get(k) as? JsonPrimitive
        val reqId = prim(envelope, "reqId")?.content
        val name = prim(envelope, "name")?.takeIf { it.isString }?.content
        val tentative = prim(envelope, "tentative")?.takeIf { it.isString }?.content
        val conf = prim(envelope, "confidence")?.content?.toFloatOrNull() ?: 0f
        val noFace = prim(envelope, "noFace")?.content?.toBooleanStrictOrNull() ?: false
        val people = (envelope["people"] as? JsonArray)?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            RecognizedFace(
                name = prim(o, "name")?.takeIf { it.isString }?.content,
                tentative = prim(o, "tentative")?.takeIf { it.isString }?.content,
                confidence = prim(o, "confidence")?.content?.toFloatOrNull() ?: 0f,
                side = prim(o, "side")?.content ?: "center",
            )
        } ?: emptyList()
        return reqId to RecognizeOutcome(name, tentative, conf, noFace, people)
    }
}
