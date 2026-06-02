package dev.pi.agent.harness

import java.time.Instant

/**
 * Kotlin port of pi-agent-core `src/harness/session/memory-storage.ts` and
 * `memory-repo.ts` + the `repo-utils` shared by storage backends.
 *
 * In-memory session tree: an append-only list of entries indexed by id, with a
 * label cache and a current leaf pointer. The repo is a `Map<id, Session>`.
 */

private fun nowIso(): String = Instant.now().toString()

private fun updateLabelCache(labelsById: MutableMap<String, String>, entry: SessionTreeEntry) {
    if (entry !is LabelEntry) return
    val label = entry.label?.trim()
    if (!label.isNullOrEmpty()) labelsById[entry.targetId] = label else labelsById.remove(entry.targetId)
}

private fun buildLabelsById(entries: List<SessionTreeEntry>): MutableMap<String, String> {
    val map = mutableMapOf<String, String>()
    for (entry in entries) updateLabelCache(map, entry)
    return map
}

internal fun generateEntryId(has: (String) -> Boolean): String {
    repeat(100) {
        val id = uuidv7().substring(0, 8)
        if (!has(id)) return id
    }
    return uuidv7()
}

private fun leafIdAfterEntry(entry: SessionTreeEntry): String? =
    if (entry is LeafEntry) entry.targetId else entry.id

class InMemorySessionStorage<TMetadata : SessionMetadata>(
    private val metadata: TMetadata,
    entries: List<SessionTreeEntry> = emptyList(),
) : SessionStorage<TMetadata> {
    private val entries: MutableList<SessionTreeEntry> = entries.toMutableList()
    private val byId: MutableMap<String, SessionTreeEntry> = entries.associateBy { it.id }.toMutableMap()
    private val labelsById = buildLabelsById(entries)
    private var leafId: String? = null

    init {
        for (entry in this.entries) leafId = leafIdAfterEntry(entry)
        val lid = leafId
        if (lid != null && !byId.containsKey(lid)) {
            throw SessionError(SessionErrorCode.INVALID_SESSION, "Entry $lid not found")
        }
    }

    override suspend fun getMetadata(): TMetadata = metadata

    override suspend fun getLeafId(): String? {
        val lid = leafId
        if (lid != null && !byId.containsKey(lid)) {
            throw SessionError(SessionErrorCode.INVALID_SESSION, "Entry $lid not found")
        }
        return lid
    }

    override suspend fun setLeafId(leafId: String?) {
        if (leafId != null && !byId.containsKey(leafId)) {
            throw SessionError(SessionErrorCode.NOT_FOUND, "Entry $leafId not found")
        }
        val entry = LeafEntry(generateEntryId(byId::containsKey), this.leafId, nowIso(), leafId)
        entries.add(entry)
        byId[entry.id] = entry
        this.leafId = leafId
    }

    override suspend fun createEntryId(): String = generateEntryId(byId::containsKey)

    override suspend fun appendEntry(entry: SessionTreeEntry) {
        entries.add(entry)
        byId[entry.id] = entry
        updateLabelCache(labelsById, entry)
        leafId = leafIdAfterEntry(entry)
    }

    override suspend fun getEntry(id: String): SessionTreeEntry? = byId[id]

    override suspend fun findEntries(type: String): List<SessionTreeEntry> = entries.filter { it.type == type }

    override suspend fun getLabel(id: String): String? = labelsById[id]

    override suspend fun getPathToRoot(leafId: String?): List<SessionTreeEntry> {
        if (leafId == null) return emptyList()
        val path = ArrayDeque<SessionTreeEntry>()
        var current = byId[leafId] ?: throw SessionError(SessionErrorCode.NOT_FOUND, "Entry $leafId not found")
        while (true) {
            path.addFirst(current)
            val pid = current.parentId ?: break
            current = byId[pid] ?: throw SessionError(SessionErrorCode.INVALID_SESSION, "Entry $pid not found")
        }
        return path.toList()
    }

    override suspend fun getEntries(): List<SessionTreeEntry> = entries.toList()
}

/** Shared fork helper (port of repo-utils.getEntriesToFork). */
internal suspend fun getEntriesToFork(
    storage: SessionStorage<*>,
    options: SessionForkOptions,
): List<SessionTreeEntry> {
    val entryId = options.entryId ?: return storage.getEntries()
    val target = storage.getEntry(entryId)
        ?: throw SessionError(SessionErrorCode.INVALID_FORK_TARGET, "Entry $entryId not found")
    val effectiveLeafId: String? = if ((options.position ?: "before") == "at") {
        target.id
    } else {
        if (target !is MessageEntry || target.message.role != "user") {
            throw SessionError(SessionErrorCode.INVALID_FORK_TARGET, "Entry $entryId is not a user message")
        }
        target.parentId
    }
    return storage.getPathToRoot(effectiveLeafId)
}

internal fun createSessionId(): String = uuidv7()
internal fun createTimestamp(): String = nowIso()

class InMemorySessionRepo : SessionRepo<BasicSessionMetadata> {
    private val sessions = mutableMapOf<String, Session<BasicSessionMetadata>>()

    override suspend fun create(id: String?): Session<BasicSessionMetadata> {
        val metadata = BasicSessionMetadata(id ?: createSessionId(), createTimestamp())
        val session = Session(InMemorySessionStorage(metadata))
        sessions[metadata.id] = session
        return session
    }

    override suspend fun open(metadata: BasicSessionMetadata): Session<BasicSessionMetadata> =
        sessions[metadata.id] ?: throw SessionError(SessionErrorCode.NOT_FOUND, "Session not found: ${metadata.id}")

    override suspend fun list(): List<BasicSessionMetadata> =
        sessions.values.map { it.getMetadata() }

    override suspend fun delete(metadata: BasicSessionMetadata) {
        sessions.remove(metadata.id)
    }

    override suspend fun fork(
        source: BasicSessionMetadata,
        options: SessionForkOptions,
    ): Session<BasicSessionMetadata> {
        val src = open(source)
        val forkedEntries = getEntriesToFork(src.getStorage(), options)
        val metadata = BasicSessionMetadata(options.id ?: createSessionId(), createTimestamp())
        val session = Session(InMemorySessionStorage(metadata, forkedEntries))
        sessions[metadata.id] = session
        return session
    }
}
