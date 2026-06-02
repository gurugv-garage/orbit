package dev.pi.agent.harness

import kotlinx.coroutines.test.runTest
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of pi-agent-core test/harness/session.test.ts, parameterized over both
 * storage backends (in-memory + JSONL on a temp dir).
 */
class SessionTest {

    private fun inMemory(): SessionStorage<*> = InMemorySessionStorage(BasicSessionMetadata("s", "2020-01-01T00:00:00Z"))

    private fun jsonl(): Pair<SessionStorage<*>, Path> {
        val dir = Files.createTempDirectory("pi-agent-session-")
        val file = dir.resolve("session.jsonl")
        return JsonlSessionStorage.create(file, dir.toString(), "session-1") to file
    }

    // ---- in-memory backend ----

    @Test fun `in-memory appends messages and builds context in order`() = runTest {
        appendsAndBuildsInOrder { inMemory() }
    }

    @Test fun `in-memory tracks model and thinking level changes`() = runTest {
        tracksModelAndThinking { inMemory() }
    }

    @Test fun `in-memory branches by moving the leaf`() = runTest { branches { inMemory() } }
    @Test fun `in-memory moves the leaf to root`() = runTest { movesToRoot { inMemory() } }
    @Test fun `in-memory reconstructs compaction summaries`() = runTest { reconstructsCompaction { inMemory() } }
    @Test fun `in-memory supports branch summary entries`() = runTest { branchSummaries { inMemory() } }
    @Test fun `in-memory supports custom message entries`() = runTest { customMessages { inMemory() } }
    @Test fun `in-memory supports labels and session info`() = runTest { labelsAndInfo { inMemory() } }
    @Test fun `in-memory rejects labels for missing entries`() = runTest { rejectsMissingLabel { inMemory() } }

    // ---- JSONL backend ----

    @Test fun `jsonl appends messages and builds context in order`() = runTest {
        appendsAndBuildsInOrder { jsonl().first }
    }

    @Test fun `jsonl persists across reopen`() = runTest {
        val (storage, file) = jsonl()
        val session = Session(storage)
        val user1 = session.appendMessage(createUserMessage("one"))
        session.appendMessage(createAssistantMessage("two"))
        session.appendLabel(user1, "checkpoint")
        session.appendSessionName("name")
        session.moveTo(user1)
        session.appendMessage(createAssistantMessage("branched"))

        val reopened = Session(JsonlSessionStorage.open(file))
        val context = reopened.buildContext()
        assertEquals(listOf("user", "assistant"), context.messages.map { it.role })
        assertEquals("checkpoint", reopened.getLabel(user1))
        assertEquals("name", reopened.getSessionName())

        // Inspect the raw file like the TS test.
        val lines = Files.readAllLines(file).filter { it.isNotBlank() }
        assertTrue(lines.size > 1)
        assertTrue(lines.drop(1).any { it.contains("\"type\":\"leaf\"") })
    }

    // ---- shared scenarios ----

    private suspend fun appendsAndBuildsInOrder(make: () -> SessionStorage<*>) {
        val session = Session(make())
        session.appendMessage(createUserMessage("one"))
        session.appendMessage(createAssistantMessage("two"))
        assertEquals(listOf("user", "assistant"), session.buildContext().messages.map { it.role })
    }

    private suspend fun tracksModelAndThinking(make: () -> SessionStorage<*>) {
        val session = Session(make())
        session.appendMessage(createUserMessage("one"))
        session.appendModelChange("openai", "gpt-4.1")
        session.appendThinkingLevelChange("high")
        val context = session.buildContext()
        assertEquals("high", context.thinkingLevel)
        assertEquals(ModelRef("openai", "gpt-4.1"), context.model)
    }

    private suspend fun branches(make: () -> SessionStorage<*>) {
        val session = Session(make())
        val user1 = session.appendMessage(createUserMessage("one"))
        val assistant1 = session.appendMessage(createAssistantMessage("two"))
        session.appendMessage(createUserMessage("three"))
        session.moveTo(user1)
        session.appendMessage(createAssistantMessage("branched"))
        val branch = session.getBranch()
        assertTrue(branch.any { it.id == user1 })
        assertTrue(branch.none { it.id == assistant1 })
        assertEquals(listOf("user", "assistant"), session.buildContext().messages.map { it.role })
    }

    private suspend fun movesToRoot(make: () -> SessionStorage<*>) {
        val session = Session(make())
        session.appendMessage(createUserMessage("one"))
        session.moveTo(null)
        assertNull(session.getLeafId())
        assertEquals(emptyList(), session.buildContext().messages)
    }

    private suspend fun reconstructsCompaction(make: () -> SessionStorage<*>) {
        val session = Session(make())
        session.appendMessage(createUserMessage("one"))
        session.appendMessage(createAssistantMessage("two"))
        val user2 = session.appendMessage(createUserMessage("three"))
        session.appendMessage(createAssistantMessage("four"))
        session.appendCompaction("summary", user2, 1234)
        session.appendMessage(createUserMessage("five"))
        val context = session.buildContext()
        assertEquals("compactionSummary", context.messages.first().role)
        assertEquals(4, context.messages.size)
    }

    private suspend fun branchSummaries(make: () -> SessionStorage<*>) {
        val session = Session(make())
        val user1 = session.appendMessage(createUserMessage("one"))
        val summaryId = session.moveTo(user1, BranchSummaryInput("summary text"))
        assertTrue(summaryId != null)
        val summaryEntry = session.getEntry(summaryId!!) as BranchSummaryEntry
        assertEquals(user1, summaryEntry.parentId)
        assertEquals(user1, summaryEntry.fromId)
        assertEquals("branchSummary", session.buildContext().messages[1].role)
    }

    private suspend fun customMessages(make: () -> SessionStorage<*>) {
        val session = Session(make())
        session.appendMessage(createUserMessage("one"))
        session.appendCustomMessageEntry("custom", listOf(dev.pi.ai.TextContent("hello")), true)
        assertEquals("custom", session.buildContext().messages[1].role)
    }

    private suspend fun labelsAndInfo(make: () -> SessionStorage<*>) {
        val session = Session(make())
        val user1 = session.appendMessage(createUserMessage("one"))
        session.appendLabel(user1, "checkpoint")
        session.appendSessionName("name")
        val entries = session.getEntries()
        assertTrue(entries.any { it.type == "label" })
        assertTrue(entries.any { it.type == "session_info" })
        assertEquals("checkpoint", session.getLabel(user1))
        assertEquals("name", session.getSessionName())
        assertEquals(1, session.buildContext().messages.size)
    }

    private suspend fun rejectsMissingLabel(make: () -> SessionStorage<*>) {
        val session = Session(make())
        val e = assertFailsWith<SessionError> { session.appendLabel("missing", "checkpoint") }
        assertTrue(e.message!!.contains("Entry missing not found"))
    }
}
