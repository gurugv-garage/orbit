package dev.orbit.dock.bench

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The benchmark's credibility is that you can read exactly why a run passed —
 *  these pin the predicate semantics so a scoring change can't slip in silently. */
class EvaluateTest {

    private fun outcome(
        output: String = "",
        tools: List<ToolCallRecord> = emptyList(),
        enums: Boolean = true,
        error: String? = null,
    ) = TurnOutcome(output, tools, enums, 10, 100, error)

    private fun tc(name: String, args: String = "{}") = ToolCallRecord(name, args)

    @Test fun toolAny_passesWhenAnyToolCalled() {
        assertTrue(Evaluate.pass(Expect(tool = "any"), outcome(tools = listOf(tc("gesture")))))
        assertFalse(Evaluate.pass(Expect(tool = "any"), outcome(output = "ok")))
    }

    @Test fun toolName_requiresThatSpecificTool() {
        assertTrue(Evaluate.pass(Expect(toolName = "move_body"), outcome(tools = listOf(tc("move_body")))))
        assertFalse(Evaluate.pass(Expect(toolName = "move_body"), outcome(tools = listOf(tc("set_face")))))
    }

    @Test fun minToolCalls_countsCalls() {
        assertTrue(Evaluate.pass(Expect(minToolCalls = 2), outcome(tools = listOf(tc("move_body"), tc("move_body")))))
        assertFalse(Evaluate.pass(Expect(minToolCalls = 2), outcome(tools = listOf(tc("move_body")))))
    }

    @Test fun noTool_rejectsAnyToolCall() {
        assertTrue(Evaluate.pass(Expect(noTool = true, nonEmptySpeech = true), outcome(output = "hi")))
        assertFalse(Evaluate.pass(Expect(noTool = true), outcome(tools = listOf(tc("move_body")))))
        assertFalse(Evaluate.pass(Expect(noTool = true), outcome(tools = listOf(tc("set_face")))))
    }

    @Test fun noMove_allowsExpressiveFaceButNotMovement() {
        // set_face during chat is desirable, not a violation.
        assertTrue(Evaluate.pass(Expect(noMove = true, nonEmptySpeech = true), outcome(output = "joke", tools = listOf(tc("set_face")))))
        assertFalse(Evaluate.pass(Expect(noMove = true), outcome(tools = listOf(tc("gesture")))))
        assertFalse(Evaluate.pass(Expect(noMove = true), outcome(tools = listOf(tc("move_body")))))
        assertFalse(Evaluate.pass(Expect(noMove = true), outcome(tools = listOf(tc("move_sequence")))))
    }

    @Test fun keywords_matchCaseInsensitiveSubstring() {
        assertTrue(Evaluate.pass(Expect(keywords = listOf("dog", "puppy")), outcome(output = "I see a cute PUPPY")))
        assertFalse(Evaluate.pass(Expect(keywords = listOf("dog")), outcome(output = "a cat")))
    }

    @Test fun validEnums_failsWhenAnyPairInvalid() {
        assertTrue(Evaluate.pass(Expect(tool = "any", validEnums = true), outcome(tools = listOf(tc("move_body")), enums = true)))
        assertFalse(Evaluate.pass(Expect(validEnums = true), outcome(tools = listOf(tc("move_body")), enums = false)))
    }

    @Test fun minSpeechChars_catchesAnnounceThenStop() {
        // "Here is a poem." (announce, ~16 chars) fails; a real poem passes.
        assertFalse(Evaluate.pass(Expect(tool = "any", minSpeechChars = 40),
            outcome(output = "Here is a poem.", tools = listOf(tc("gesture")))))
        assertTrue(Evaluate.pass(Expect(tool = "any", minSpeechChars = 40),
            outcome(output = "Stars blink in the quiet night, dreams take flight on wings of light.", tools = listOf(tc("gesture")))))
    }

    @Test fun combinedPredicates_allMustHold() {
        val expect = Expect(tool = "any", nonEmptySpeech = true)
        assertTrue(Evaluate.pass(expect, outcome(output = "here it is", tools = listOf(tc("gesture")))))
        assertFalse(Evaluate.pass(expect, outcome(output = "", tools = listOf(tc("gesture")))))  // no speech
        assertFalse(Evaluate.pass(expect, outcome(output = "here it is")))                          // no tool
    }

    @Test fun anyError_failsRegardlessOfPredicates() {
        assertFalse(Evaluate.pass(Expect(nonEmptySpeech = true), outcome(output = "hi", error = "timeout")))
    }
}
