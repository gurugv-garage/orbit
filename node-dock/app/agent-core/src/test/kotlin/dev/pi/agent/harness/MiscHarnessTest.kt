package dev.pi.agent.harness

import dev.pi.ai.AssistantMessage
import dev.pi.ai.Cost
import dev.pi.ai.ImageContent
import dev.pi.ai.StopReason
import dev.pi.ai.TextContent
import dev.pi.ai.ThinkingContent
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Usage
import dev.pi.ai.UserMessage
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Ports of system-prompt, prompt-templates, truncate, and compaction tests. */
class MiscHarnessTest {

    // ---- system-prompt.test.ts ----

    private val visibleSkill = Skill("visible", "Use <this> & that", "visible content", "/skills/visible/SKILL.md")
    private val secondSkill = Skill("second", "Second skill", "second content", "/skills/second/SKILL.md")
    private val disabledSkill = Skill("hidden", "Hidden", "hidden content", "/skills/hidden/SKILL.md", disableModelInvocation = true)

    @Test fun `formats visible skills in order and skips disabled`() {
        val expected = """
            The following skills provide specialized instructions for specific tasks.
            Read the full skill file when the task matches its description.
            When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

            <available_skills>
              <skill>
                <name>visible</name>
                <description>Use &lt;this&gt; &amp; that</description>
                <location>/skills/visible/SKILL.md</location>
              </skill>
              <skill>
                <name>second</name>
                <description>Second skill</description>
                <location>/skills/second/SKILL.md</location>
              </skill>
            </available_skills>
        """.trimIndent()
        assertEquals(expected, formatSkillsForSystemPrompt(listOf(visibleSkill, disabledSkill, secondSkill)))
    }

    @Test fun `empty string when no visible skills`() {
        assertEquals("", formatSkillsForSystemPrompt(listOf(disabledSkill)))
    }

    @Test fun `escapes xml in all visible fields`() {
        val out = formatSkillsForSystemPrompt(
            listOf(Skill("a&b", "Quote \"double\" and 'single'", "content", "/skills/<bad>&\"quote\"/SKILL.md")),
        )
        assertTrue(
            out.contains(
                "<name>a&amp;b</name>\n    <description>Quote &quot;double&quot; and &apos;single&apos;</description>\n    <location>/skills/&lt;bad&gt;&amp;&quot;quote&quot;/SKILL.md</location>",
            ),
        )
    }

    // ---- prompt-templates.test.ts (formatPromptTemplateInvocation) ----

    @Test fun `substitutes command arguments`() {
        val content = "\$1 \${@:2} \$ARGUMENTS"
        assertEquals(
            "hello world test hello world test",
            formatPromptTemplateInvocation(PromptTemplate("one", content), listOf("hello world", "test")),
        )
    }

    @Test fun `parses shell-style quoted args`() {
        assertEquals(listOf("a b", "c", "d e"), parseCommandArgs("\"a b\" c 'd e'"))
    }

    // ---- truncate.test.ts ----

    @Test fun `counts UTF-8 bytes without partial lines`() {
        val content = "aé🙂\nb"
        val result = truncateHead(content, maxBytes = 100, maxLines = 10)
        assertFalse(result.truncated)
        assertEquals(9, result.totalBytes)
        assertEquals(result.totalBytes, result.outputBytes)
    }

    @Test fun `truncates head on UTF-8 byte limits without partial lines`() {
        val result = truncateHead("éé\nabc", maxBytes = 4, maxLines = 10)
        assertEquals("éé", result.content)
        assertTrue(result.truncated)
        assertEquals("bytes", result.truncatedBy)
        assertEquals(4, result.outputBytes)
        assertFalse(result.firstLineExceedsLimit)
    }

    @Test fun `reports head truncation when first line exceeds byte limit`() {
        val result = truncateHead("éé\nabc", maxBytes = 3, maxLines = 10)
        assertEquals("", result.content)
        assertTrue(result.truncated)
        assertTrue(result.firstLineExceedsLimit)
    }

    @Test fun `tail matches a UTF-8-safe byte tail across limits`() {
        // Mirror the TS property test: tail output must never split a UTF-8 char
        // and must never exceed the byte budget.
        for (input in listOf("abc\ndef\nghi", "éé\nabc", "🙂🙂🙂\nx")) {
            val totalBytes = input.toByteArray(Charsets.UTF_8).size
            for (maxBytes in 0..totalBytes + 4) {
                val result = truncateTail(input, maxBytes = maxBytes, maxLines = 10)
                assertTrue(
                    result.content.toByteArray(Charsets.UTF_8).size <= maxBytes ||
                        // line-limited (not byte-limited) results may exceed a tiny byte budget only when not truncatedBy bytes
                        result.truncatedBy != "bytes",
                    "tail exceeded byte limit input=$input maxBytes=$maxBytes",
                )
            }
        }
    }

    // ---- compaction.test.ts (token helpers) ----

    private fun usage(input: Int, output: Int, cacheRead: Int, cacheWrite: Int) =
        Usage(input, output, cacheRead, cacheWrite, totalTokens = input + output + cacheRead + cacheWrite, cost = Cost())

    @Test fun `calculates total context tokens from usage`() {
        assertEquals(1800, calculateContextTokens(usage(1000, 500, 200, 100)))
        assertEquals(0, calculateContextTokens(usage(0, 0, 0, 0)))
    }

    @Test fun `checks compaction threshold`() {
        val settings = CompactionSettings(enabled = true, reserveTokens = 10000, keepRecentTokens = 20000)
        assertTrue(shouldCompact(95000, 100000, settings))
        assertFalse(shouldCompact(89000, 100000, settings))
        assertFalse(shouldCompact(95000, 100000, settings.copy(enabled = false)))
    }

    @Test fun `estimates tokens across supported message roles`() {
        val assistant = AssistantMessage(
            content = listOf(
                TextContent("hello there"),
                ThinkingContent("reasoning"),
                ToolCall("c1", "echo", buildJsonObject { put("value", "x") }),
            ),
            api = "a", provider = "p", model = "m", usage = Usage.EMPTY, stopReason = StopReason.STOP,
        )
        val toolResultImg = ToolResultMessage("c1", "echo", listOf(ImageContent("data", "image/png")), isError = false)
        assertTrue(estimateTokens(UserMessage.text("plain user")) > 0)
        assertTrue(estimateTokens(assistant) > 0)
        assertTrue(estimateTokens(CustomMessage("c", listOf(TextContent("blah")), true)) > 0)
        assertTrue(estimateTokens(toolResultImg) > 1000)
        assertTrue(estimateTokens(BranchSummaryMessage("a branch summary", "id")) > 0)
        assertTrue(estimateTokens(CompactionSummaryMessage("a compaction summary", 10)) > 0)
    }

    @Test fun `estimateContextTokens prefers latest assistant usage`() {
        val noUsage = estimateContextTokens(listOf(UserMessage.text("no usage")))
        assertNull(noUsage.lastUsageIndex)

        val assistant = AssistantMessage(
            content = listOf(TextContent("hi")),
            api = "a", provider = "p", model = "m",
            usage = usage(1000, 0, 0, 0), stopReason = StopReason.STOP,
        )
        val est = estimateContextTokens(listOf(assistant, UserMessage.text("tail")))
        assertEquals(0, est.lastUsageIndex)
        assertEquals(1000, est.usageTokens)
        assertTrue(est.trailingTokens > 0)
    }

    @Test fun `serializes conversation with truncated tool results`() {
        val long = "x".repeat(3000)
        val messages = listOf(
            UserMessage.text("hello"),
            AssistantMessage(
                content = listOf(TextContent("hi"), ToolCall("c1", "echo", buildJsonObject { put("v", "1") })),
                api = "a", provider = "p", model = "m", usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
            ),
            ToolResultMessage("c1", "echo", listOf(TextContent(long)), isError = false),
        )
        val result = serializeConversation(messages)
        assertTrue(result.contains("[User]: hello"))
        assertTrue(result.contains("[Assistant]: hi"))
        assertTrue(result.contains("[Assistant tool calls]: echo("))
        assertTrue(result.contains("more characters truncated"))
    }
}
