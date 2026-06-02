package dev.pi.ai

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** Port of pi-ai test/validation.test.ts. */
class ValidationTest {

    private fun echoTool(valueSchema: JsonObject): Tool = Tool(
        name = "echo",
        description = "Echo tool",
        parameters = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") { put("value", valueSchema) }
            putJsonArray("required") { add("value") }
        },
    )

    private fun valueSchema(vararg types: String): JsonObject = buildJsonObject {
        if (types.size == 1) put("type", types[0])
        else putJsonArray("type") { types.forEach { add(it) } }
    }

    private fun run(valueSchema: JsonObject, input: JsonElement): JsonElement {
        val tool = echoTool(valueSchema)
        val args = buildJsonObject { put("value", input) }
        return (validateToolArguments(tool, args))["value"]!!
    }

    @Test
    fun `coerces serialized plain JSON schemas with AJV-compatible primitive rules`() {
        data class Case(val schema: JsonObject, val input: JsonElement, val expected: JsonElement)
        val cases = listOf(
            Case(valueSchema("number"), JsonPrimitive("42"), JsonPrimitive(42)),
            Case(valueSchema("number"), JsonPrimitive(true), JsonPrimitive(1)),
            Case(valueSchema("number"), JsonNull, JsonPrimitive(0)),
            Case(valueSchema("integer"), JsonPrimitive("42"), JsonPrimitive(42)),
            Case(valueSchema("boolean"), JsonPrimitive("true"), JsonPrimitive(true)),
            Case(valueSchema("boolean"), JsonPrimitive("false"), JsonPrimitive(false)),
            Case(valueSchema("boolean"), JsonPrimitive(1), JsonPrimitive(true)),
            Case(valueSchema("boolean"), JsonPrimitive(0), JsonPrimitive(false)),
            Case(valueSchema("string"), JsonNull, JsonPrimitive("")),
            Case(valueSchema("string"), JsonPrimitive(true), JsonPrimitive("true")),
            Case(valueSchema("null"), JsonPrimitive(""), JsonNull),
            Case(valueSchema("null"), JsonPrimitive(0), JsonNull),
            Case(valueSchema("null"), JsonPrimitive(false), JsonNull),
            Case(valueSchema("number", "string"), JsonPrimitive("1"), JsonPrimitive("1")),
            Case(valueSchema("boolean", "number"), JsonPrimitive("1"), JsonPrimitive(1)),
        )
        for (c in cases) {
            assertEquals(c.expected, run(c.schema, c.input), "schema=${c.schema} input=${c.input}")
        }
    }

    @Test
    fun `rejects invalid coercions for serialized plain JSON schemas`() {
        val failing = listOf(
            valueSchema("boolean") to JsonPrimitive("1"),
            valueSchema("boolean") to JsonPrimitive("0"),
            valueSchema("null") to JsonPrimitive("null"),
            valueSchema("integer") to JsonPrimitive("42.1"),
        )
        for ((schema, input) in failing) {
            assertFailsWith<ToolValidationException>("schema=$schema input=$input") {
                run(schema, input)
            }
        }
    }

    @Test
    fun `coerces string arguments to a typed number`() {
        val tool = Tool(
            "echo", "Echo",
            buildJsonObject {
                put("type", "object")
                putJsonObject("properties") { putJsonObject("count") { put("type", "number") } }
                putJsonArray("required") { add("count") }
            },
        )
        val result = validateToolArguments(tool, buildJsonObject { put("count", "42") })
        assertEquals(JsonPrimitive(42), result["count"])
    }
}
