package dev.pi.agent.harness

import kotlinx.coroutines.test.runTest
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Port of pi-agent-core test/harness/repo.test.ts. */
class RepoTest {

    @Test
    fun `InMemorySessionRepo opens, deletes, and forks by metadata`() = runTest {
        val repo = InMemorySessionRepo()
        val session = repo.create("session-1")
        val metadata = session.getMetadata()
        val user1 = session.appendMessage(createUserMessage("one"))
        val assistant1 = session.appendMessage(createAssistantMessage("two"))
        val user2 = session.appendMessage(createUserMessage("three"))

        assertEquals(session, repo.open(metadata))
        assertEquals(listOf("session-1"), repo.list().map { it.id })

        val fork = repo.fork(metadata, SessionForkOptions(entryId = user2, id = "session-2"))
        assertEquals(listOf(user1, assistant1), fork.getEntries().map { it.id })

        val fullFork = repo.fork(metadata, SessionForkOptions(id = "session-3"))
        assertEquals(listOf(user1, assistant1, user2), fullFork.getEntries().map { it.id })

        repo.delete(metadata)
        val e = assertFailsWith<SessionError> { repo.open(metadata) }
        assertTrue(e.message!!.contains("Session not found: session-1"))
    }

    @Test
    fun `JsonlSessionRepo stores below encoded cwd directories and lists by cwd`() = runTest {
        val root = Files.createTempDirectory("pi-agent-root-")
        val repo = JsonlSessionRepo(root)
        val cwd = "/tmp/my-project"
        val otherCwd = "/tmp/other-project"
        val session = repo.create(cwd, "019de8c2-de29-73e9-ae0c-e134db34c447")
        val otherSession = repo.create(otherCwd, "other-session")
        val metadata = session.getMetadata()
        val otherMetadata = otherSession.getMetadata()

        assertTrue(metadata.path.contains("--tmp-my-project--"))
        assertTrue(otherMetadata.path.contains("--tmp-other-project--"))
        assertTrue(Files.exists(java.nio.file.Path.of(metadata.path)))

        assertEquals(listOf(metadata.id), repo.list(cwd).map { it.id })
        assertEquals(
            listOf(metadata.id, otherMetadata.id).sorted(),
            repo.list(null).map { it.id }.sorted(),
        )
    }

    @Test
    fun `JsonlSessionRepo opens, deletes, and forks by metadata`() = runTest {
        val root = Files.createTempDirectory("pi-agent-root-")
        val repo = JsonlSessionRepo(root)
        val source = repo.create("/tmp/source", "source-session")
        val sourceMetadata = source.getMetadata()
        val user1 = source.appendMessage(createUserMessage("one"))
        val assistant1 = source.appendMessage(createAssistantMessage("two"))
        val user2 = source.appendMessage(createUserMessage("three"))

        assertEquals(sourceMetadata, repo.open(sourceMetadata).getMetadata())

        val fork = repo.fork(sourceMetadata, "/tmp/target", SessionForkOptions(entryId = user2, id = "fork-session"))
        val forkMetadata = fork.getMetadata()
        assertEquals("/tmp/target", forkMetadata.cwd)
        assertEquals(sourceMetadata.path, forkMetadata.parentSessionPath)
        assertEquals(listOf(user1, assistant1), fork.getEntries().map { it.id })

        val fullFork = repo.fork(sourceMetadata, "/tmp/target", SessionForkOptions(id = "full-fork-session"))
        assertEquals(listOf(user1, assistant1, user2), fullFork.getEntries().map { it.id })

        repo.delete(sourceMetadata)
        assertTrue(!Files.exists(java.nio.file.Path.of(sourceMetadata.path)))
        assertFailsWith<SessionError> { repo.open(sourceMetadata) }
    }
}
