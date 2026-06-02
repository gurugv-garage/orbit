package dev.pi.ai

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * Port of pi-ai's `validateToolArguments` (utils/validation.ts).
 *
 * The original validates against a TypeBox schema and applies AJV-compatible
 * primitive coercion for plain serialized JSON schemas (e.g. string "42" ->
 * number 42). Here the schema is a plain [JsonObject] and values are
 * [JsonElement]s, so we implement the same coercion + a structural check.
 */

class ToolValidationException(message: String) : RuntimeException(message)

/** Validate (and coerce) raw tool-call arguments against the tool's JSON schema. */
fun validateToolArguments(tool: Tool, args: JsonObject): JsonObject {
    val coerced = coerceWithJsonSchema(args, tool.parameters)
    if (checkSchema(coerced, tool.parameters)) {
        return coerced as? JsonObject ?: args
    }
    val errors = collectErrors(coerced, tool.parameters, "")
        .joinToString("\n") { "  - ${it.first}: ${it.second}" }
        .ifEmpty { "Unknown validation error" }
    throw ToolValidationException(
        "Validation failed for tool \"${tool.name}\":\n$errors\n\nReceived arguments:\n$args",
    )
}

// ---------------------------------------------------------------------------
// Schema type helpers
// ---------------------------------------------------------------------------

private fun schemaTypes(schema: JsonObject): List<String> {
    return when (val t = schema["type"]) {
        is JsonPrimitive -> if (t.isString) listOf(t.content) else emptyList()
        is JsonArray -> t.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        else -> emptyList()
    }
}

private fun matchesJsonType(value: JsonElement, type: String): Boolean = when (type) {
    "number" -> value is JsonPrimitive && !value.isString && value.doubleOrNull != null
    "integer" -> value is JsonPrimitive && !value.isString && value.doubleOrNull?.let { it == Math.floor(it) && !it.isInfinite() } == true
    "boolean" -> value is JsonPrimitive && !value.isString && value.booleanOrNull != null
    "string" -> value is JsonPrimitive && value.isString
    "null" -> value is JsonNull
    "array" -> value is JsonArray
    "object" -> value is JsonObject
    else -> false
}

// ---------------------------------------------------------------------------
// Coercion (AJV-compatible, ported from coercePrimitiveByType)
// ---------------------------------------------------------------------------

private fun coercePrimitiveByType(value: JsonElement, type: String): JsonElement {
    when (type) {
        "number" -> {
            if (value is JsonNull) return JsonPrimitive(0)
            if (value is JsonPrimitive) {
                if (value.isString) {
                    val s = value.content
                    if (s.trim().isNotEmpty()) {
                        val parsed = s.toDoubleOrNull()
                        if (parsed != null && parsed.isFinite()) return numberLiteral(parsed)
                    }
                } else value.booleanOrNull?.let { return JsonPrimitive(if (it) 1 else 0) }
            }
            return value
        }
        "integer" -> {
            if (value is JsonNull) return JsonPrimitive(0)
            if (value is JsonPrimitive) {
                if (value.isString) {
                    val s = value.content
                    if (s.trim().isNotEmpty()) {
                        val parsed = s.toDoubleOrNull()
                        if (parsed != null && parsed == Math.floor(parsed) && !parsed.isInfinite()) {
                            return numberLiteral(parsed)
                        }
                    }
                } else value.booleanOrNull?.let { return JsonPrimitive(if (it) 1 else 0) }
            }
            return value
        }
        "boolean" -> {
            if (value is JsonNull) return JsonPrimitive(false)
            if (value is JsonPrimitive) {
                if (value.isString) {
                    if (value.content == "true") return JsonPrimitive(true)
                    if (value.content == "false") return JsonPrimitive(false)
                } else {
                    val d = value.doubleOrNull
                    if (d == 1.0) return JsonPrimitive(true)
                    if (d == 0.0) return JsonPrimitive(false)
                }
            }
            return value
        }
        "string" -> {
            if (value is JsonNull) return JsonPrimitive("")
            if (value is JsonPrimitive && !value.isString) {
                // number or boolean -> its JS String() form
                value.booleanOrNull?.let { return JsonPrimitive(it.toString()) }
                value.doubleOrNull?.let { return JsonPrimitive(numberToJsString(it)) }
            }
            return value
        }
        "null" -> {
            if (value is JsonPrimitive) {
                if (value.isString && value.content == "") return JsonNull
                if (!value.isString) {
                    if (value.doubleOrNull == 0.0) return JsonNull
                    if (value.booleanOrNull == false) return JsonNull
                }
            }
            return value
        }
        else -> return value
    }
}

private fun coerceWithUnionSchema(value: JsonElement, schemas: List<JsonObject>): JsonElement {
    for (schema in schemas) {
        val coerced = coerceWithJsonSchema(value, schema)
        if (checkSchema(coerced, schema)) return coerced
    }
    return value
}

private fun coerceWithJsonSchema(value: JsonElement, schema: JsonObject): JsonElement {
    var next = value

    (schema["allOf"] as? JsonArray)?.forEach { nested ->
        if (nested is JsonObject) next = coerceWithJsonSchema(next, nested)
    }
    (schema["anyOf"] as? JsonArray)?.let { arr ->
        next = coerceWithUnionSchema(next, arr.filterIsInstance<JsonObject>())
    }
    (schema["oneOf"] as? JsonArray)?.let { arr ->
        next = coerceWithUnionSchema(next, arr.filterIsInstance<JsonObject>())
    }

    val types = schemaTypes(schema)
    val matchesUnionMember = types.size > 1 && types.any { matchesJsonType(next, it) }
    if (types.isNotEmpty() && !matchesUnionMember) {
        for (type in types) {
            val candidate = coercePrimitiveByType(next, type)
            if (candidate != next) {
                next = candidate
                break
            }
        }
    }

    if (types.contains("object") && next is JsonObject) {
        next = applyObjectCoercion(next, schema)
    }
    if (types.contains("array") && next is JsonArray) {
        next = applyArrayCoercion(next, schema)
    }
    return next
}

private fun applyObjectCoercion(value: JsonObject, schema: JsonObject): JsonObject {
    val props = schema["properties"] as? JsonObject
    val definedKeys = props?.keys ?: emptySet()
    val out = LinkedHashMap<String, JsonElement>(value)

    if (props != null) {
        for ((key, propSchema) in props) {
            if (key in out && propSchema is JsonObject) {
                out[key] = coerceWithJsonSchema(out[key]!!, propSchema)
            }
        }
    }
    val additional = schema["additionalProperties"]
    if (additional is JsonObject) {
        for ((key, v) in value) {
            if (key in definedKeys) continue
            out[key] = coerceWithJsonSchema(v, additional)
        }
    }
    return JsonObject(out)
}

private fun applyArrayCoercion(value: JsonArray, schema: JsonObject): JsonArray {
    val items = schema["items"]
    return when (items) {
        is JsonArray -> JsonArray(value.mapIndexed { i, el ->
            (items.getOrNull(i) as? JsonObject)?.let { coerceWithJsonSchema(el, it) } ?: el
        })
        is JsonObject -> JsonArray(value.map { coerceWithJsonSchema(it, items) })
        else -> value
    }
}

// ---------------------------------------------------------------------------
// Structural check (required + type) — enough for the agent's tool gate.
// ---------------------------------------------------------------------------

private fun checkSchema(value: JsonElement, schema: JsonObject): Boolean =
    collectErrors(value, schema, "").isEmpty()

private fun collectErrors(value: JsonElement, schema: JsonObject, path: String): List<Pair<String, String>> {
    val errors = mutableListOf<Pair<String, String>>()
    val here = path.ifEmpty { "root" }

    val types = schemaTypes(schema)
    if (types.isNotEmpty() && types.none { matchesJsonType(value, it) }) {
        errors += here to "Expected ${types.joinToString(" | ")}"
        return errors // no point descending if the top-level type is wrong
    }

    if (types.contains("object") && value is JsonObject) {
        val required = (schema["required"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
        for (req in required) {
            if (req !in value) {
                val p = if (path.isEmpty()) req else "$path.$req"
                errors += p to "Required property missing"
            }
        }
        val props = schema["properties"] as? JsonObject
        if (props != null) {
            for ((key, sub) in props) {
                if (key in value && sub is JsonObject) {
                    val childPath = if (path.isEmpty()) key else "$path.$key"
                    errors += collectErrors(value[key]!!, sub, childPath)
                }
            }
        }
    }

    if (types.contains("array") && value is JsonArray) {
        val items = schema["items"]
        if (items is JsonObject) {
            value.forEachIndexed { i, el ->
                errors += collectErrors(el, items, if (path.isEmpty()) "$i" else "$path.$i")
            }
        }
    }
    return errors
}

// ---------------------------------------------------------------------------
// Number formatting helpers (mirror JS Number semantics)
// ---------------------------------------------------------------------------

/** Build an integer-valued literal where possible so `{value: 42}` != `42.0`. */
private fun numberLiteral(d: Double): JsonPrimitive =
    if (d == Math.floor(d) && !d.isInfinite() && Math.abs(d) < 1e15) JsonPrimitive(d.toLong())
    else JsonPrimitive(d)

/** JS `String(number)`: integers render without a trailing ".0". */
private fun numberToJsString(d: Double): String =
    if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()
