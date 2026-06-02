package dev.pi.agent.harness

import dev.pi.ai.AgentMessage
import java.time.Instant

/**
 * Kotlin port of pi-agent-core `src/harness/session/session.ts`.
 *
 * [buildSessionContext] replays a root→leaf path into a conversation context,
 * honoring compaction (history before the cut is replaced by a summary). The
 * [Session] class is a thin typed API over a [SessionStorage] for appending
 * entries and navigating the tree.
 */

fun buildSessionContext(pathEntries: List<SessionTreeEntry>): SessionContext {
    var thinkingLevel = "off"
    var model: ModelRef? = null
    var activeToolNames: List<String>? = null
    var compaction: CompactionEntry? = null

    for (entry in pathEntries) {
        when (entry) {
            is ThinkingLevelChangeEntry -> thinkingLevel = entry.thinkingLevel
            is ModelChangeEntry -> model = ModelRef(entry.provider, entry.modelId)
            is MessageEntry -> {
                val m = entry.message
                if (m is dev.pi.ai.AssistantMessage) model = ModelRef(m.provider, m.model)
            }
            is ActiveToolsChangeEntry -> activeToolNames = entry.activeToolNames.toList()
            is CompactionEntry -> compaction = entry
            else -> {}
        }
    }

    val messages = mutableListOf<AgentMessage>()
    fun appendMessage(entry: SessionTreeEntry) {
        when (entry) {
            is MessageEntry -> messages.add(entry.message)
            is CustomMessageEntry -> messages.add(
                createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
            )
            is BranchSummaryEntry -> if (entry.summary.isNotEmpty()) {
                messages.add(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp))
            }
            else -> {}
        }
    }

    val comp = compaction
    if (comp != null) {
        messages.add(createCompactionSummaryMessage(comp.summary, comp.tokensBefore, comp.timestamp))
        val compactionIdx = pathEntries.indexOfFirst { it is CompactionEntry && it.id == comp.id }
        var foundFirstKept = false
        for (i in 0 until compactionIdx) {
            val entry = pathEntries[i]
            if (entry.id == comp.firstKeptEntryId) foundFirstKept = true
            if (foundFirstKept) appendMessage(entry)
        }
        for (i in compactionIdx + 1 until pathEntries.size) appendMessage(pathEntries[i])
    } else {
        for (entry in pathEntries) appendMessage(entry)
    }

    return SessionContext(messages, thinkingLevel, model, activeToolNames)
}

private fun nowIso(): String = Instant.now().toString()

class Session<TMetadata : SessionMetadata>(private val storage: SessionStorage<TMetadata>) {

    suspend fun getMetadata(): TMetadata = storage.getMetadata()
    fun getStorage(): SessionStorage<TMetadata> = storage
    suspend fun getLeafId(): String? = storage.getLeafId()
    suspend fun getEntry(id: String): SessionTreeEntry? = storage.getEntry(id)
    suspend fun getEntries(): List<SessionTreeEntry> = storage.getEntries()

    suspend fun getBranch(fromId: String? = null): List<SessionTreeEntry> {
        val leafId = fromId ?: storage.getLeafId()
        return storage.getPathToRoot(leafId)
    }

    suspend fun buildContext(): SessionContext = buildSessionContext(getBranch())

    suspend fun getLabel(id: String): String? = storage.getLabel(id)

    suspend fun getSessionName(): String? =
        storage.findEntries("session_info").lastOrNull()
            ?.let { (it as SessionInfoEntry).name?.trim() }
            ?.ifEmpty { null }

    private suspend fun appendTyped(entry: SessionTreeEntry): String {
        storage.appendEntry(entry)
        return entry.id
    }

    suspend fun appendMessage(message: AgentMessage): String = appendTyped(
        MessageEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), message),
    )

    suspend fun appendThinkingLevelChange(thinkingLevel: String): String = appendTyped(
        ThinkingLevelChangeEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), thinkingLevel),
    )

    suspend fun appendModelChange(provider: String, modelId: String): String = appendTyped(
        ModelChangeEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), provider, modelId),
    )

    suspend fun appendActiveToolsChange(activeToolNames: List<String>): String = appendTyped(
        ActiveToolsChangeEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), activeToolNames.toList()),
    )

    suspend fun appendCompaction(
        summary: String,
        firstKeptEntryId: String,
        tokensBefore: Int,
        details: Any? = null,
        fromHook: Boolean? = null,
    ): String = appendTyped(
        CompactionEntry(
            storage.createEntryId(), storage.getLeafId(), nowIso(),
            summary, firstKeptEntryId, tokensBefore, details, fromHook,
        ),
    )

    suspend fun appendCustomEntry(customType: String, data: Any? = null): String = appendTyped(
        CustomEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), customType, data),
    )

    suspend fun appendCustomMessageEntry(
        customType: String,
        content: List<dev.pi.ai.Content>,
        display: Boolean,
        details: Any? = null,
    ): String = appendTyped(
        CustomMessageEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), customType, content, display, details),
    )

    suspend fun appendLabel(targetId: String, label: String?): String {
        if (storage.getEntry(targetId) == null) {
            throw SessionError(SessionErrorCode.NOT_FOUND, "Entry $targetId not found")
        }
        return appendTyped(
            LabelEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), targetId, label),
        )
    }

    suspend fun appendSessionName(name: String): String = appendTyped(
        SessionInfoEntry(storage.createEntryId(), storage.getLeafId(), nowIso(), name.trim()),
    )

    suspend fun moveTo(
        entryId: String?,
        summary: BranchSummaryInput? = null,
    ): String? {
        if (entryId != null && storage.getEntry(entryId) == null) {
            throw SessionError(SessionErrorCode.NOT_FOUND, "Entry $entryId not found")
        }
        storage.setLeafId(entryId)
        if (summary == null) return null
        return appendTyped(
            BranchSummaryEntry(
                storage.createEntryId(), entryId, nowIso(),
                fromId = entryId ?: "root",
                summary = summary.summary,
                details = summary.details,
                fromHook = summary.fromHook,
            ),
        )
    }
}

data class BranchSummaryInput(val summary: String, val details: Any? = null, val fromHook: Boolean? = null)
