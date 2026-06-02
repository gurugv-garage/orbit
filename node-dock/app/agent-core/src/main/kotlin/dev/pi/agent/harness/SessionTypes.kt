package dev.pi.agent.harness

import dev.pi.ai.AgentMessage
import dev.pi.ai.Content

/**
 * Kotlin port of the session-tree types from pi-agent-core `src/harness/types.ts`.
 *
 * A session is an append-only tree of [SessionTreeEntry]s. The active path runs
 * from a leaf back to the root; replaying it reconstructs the conversation
 * (see [buildSessionContext]). Branching = pointing the leaf at an older entry.
 */

sealed interface SessionTreeEntry {
    val type: String
    val id: String
    val parentId: String?
    val timestamp: String
}

data class MessageEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val message: AgentMessage,
) : SessionTreeEntry { override val type get() = "message" }

data class ThinkingLevelChangeEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val thinkingLevel: String,
) : SessionTreeEntry { override val type get() = "thinking_level_change" }

data class ModelChangeEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val provider: String,
    val modelId: String,
) : SessionTreeEntry { override val type get() = "model_change" }

data class ActiveToolsChangeEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val activeToolNames: List<String>,
) : SessionTreeEntry { override val type get() = "active_tools_change" }

data class CompactionEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val summary: String,
    val firstKeptEntryId: String,
    val tokensBefore: Int,
    val details: Any? = null,
    val fromHook: Boolean? = null,
) : SessionTreeEntry { override val type get() = "compaction" }

data class BranchSummaryEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val fromId: String,
    val summary: String,
    val details: Any? = null,
    val fromHook: Boolean? = null,
) : SessionTreeEntry { override val type get() = "branch_summary" }

data class CustomEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val customType: String,
    val data: Any? = null,
) : SessionTreeEntry { override val type get() = "custom" }

data class CustomMessageEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val customType: String,
    val content: List<Content>,
    val display: Boolean,
    val details: Any? = null,
) : SessionTreeEntry { override val type get() = "custom_message" }

data class LabelEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val targetId: String,
    val label: String?,
) : SessionTreeEntry { override val type get() = "label" }

data class SessionInfoEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val name: String? = null,
) : SessionTreeEntry { override val type get() = "session_info" }

data class LeafEntry(
    override val id: String,
    override val parentId: String?,
    override val timestamp: String,
    val targetId: String?,
) : SessionTreeEntry { override val type get() = "leaf" }

/** Reconstructed conversation context from a session branch. */
data class SessionContext(
    val messages: List<AgentMessage>,
    val thinkingLevel: String,
    val model: ModelRef?,
    val activeToolNames: List<String>?,
)

data class ModelRef(val provider: String, val modelId: String)

interface SessionMetadata {
    val id: String
    val createdAt: String
}

data class BasicSessionMetadata(
    override val id: String,
    override val createdAt: String,
) : SessionMetadata

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

enum class SessionErrorCode {
    NOT_FOUND, INVALID_SESSION, INVALID_ENTRY, INVALID_FORK_TARGET, STORAGE, UNKNOWN
}

class SessionError(
    val code: SessionErrorCode,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

// ---------------------------------------------------------------------------
// Storage + repo contracts
// ---------------------------------------------------------------------------

/** Append-only storage for one session's entry tree. */
interface SessionStorage<TMetadata : SessionMetadata> {
    suspend fun getMetadata(): TMetadata
    suspend fun getLeafId(): String?
    suspend fun setLeafId(leafId: String?)
    suspend fun createEntryId(): String
    suspend fun appendEntry(entry: SessionTreeEntry)
    suspend fun getEntry(id: String): SessionTreeEntry?
    suspend fun findEntries(type: String): List<SessionTreeEntry>
    suspend fun getLabel(id: String): String?
    suspend fun getPathToRoot(leafId: String?): List<SessionTreeEntry>
    suspend fun getEntries(): List<SessionTreeEntry>
}

data class SessionForkOptions(
    val entryId: String? = null,
    val position: String? = null, // "before" | "at"
    val id: String? = null,
)

interface SessionRepo<TMetadata : SessionMetadata> {
    suspend fun create(id: String? = null): Session<TMetadata>
    suspend fun open(metadata: TMetadata): Session<TMetadata>
    suspend fun list(): List<TMetadata>
    suspend fun delete(metadata: TMetadata)
    suspend fun fork(source: TMetadata, options: SessionForkOptions): Session<TMetadata>
}
