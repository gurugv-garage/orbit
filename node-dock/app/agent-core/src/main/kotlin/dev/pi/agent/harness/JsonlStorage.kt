package dev.pi.agent.harness

import dev.pi.ai.AgentMessage
import dev.pi.ai.AssistantMessage
import dev.pi.ai.Content
import dev.pi.ai.StopReason
import dev.pi.ai.TextContent
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Usage
import dev.pi.ai.UserMessage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/**
 * Kotlin port of pi-agent-core `src/harness/session/jsonl-storage.ts` and
 * `jsonl-repo.ts`, backed by `java.nio` instead of the TS `FileSystem`
 * capability interface (which is Node-environment plumbing out of scope here).
 *
 * Wire format matches the original: line 1 is a `{type:"session",version:3,...}`
 * header; each later line is one tree entry. Message content is serialized as a
 * text/role subset — enough for context reconstruction; image and tool-call
 * content fidelity is a known simplification of this port.
 */

private val JSON = Json { encodeDefaults = false }

private fun nowIso(): String = Instant.now().toString()

private fun contentToJson(content: List<Content>): JsonArray = buildJsonArray {
    for (c in content) when (c) {
        is TextContent -> add(buildJsonObject { put("type", "text"); put("text", c.text) })
        is dev.pi.ai.ImageContent -> add(buildJsonObject {
            put("type", "image"); put("data", c.data); put("mimeType", c.mimeType)
        })
        else -> add(buildJsonObject { put("type", "text"); put("text", "") })
    }
}

private fun jsonToContent(arr: JsonArray): List<Content> = arr.mapNotNull { el ->
    val obj = el.jsonObject
    when (obj["type"]?.jsonPrimitive?.content) {
        "text" -> TextContent(obj["text"]?.jsonPrimitive?.content ?: "")
        "image" -> dev.pi.ai.ImageContent(
            obj["data"]?.jsonPrimitive?.content ?: "",
            obj["mimeType"]?.jsonPrimitive?.content ?: "",
        )
        else -> null
    }
}

private fun messageToJson(m: AgentMessage): JsonObject = when (m) {
    is UserMessage -> buildJsonObject {
        put("role", "user"); put("content", contentToJson(m.content)); put("timestamp", m.timestamp)
    }
    is AssistantMessage -> buildJsonObject {
        put("role", "assistant"); put("content", contentToJson(m.content))
        put("api", m.api); put("provider", m.provider); put("model", m.model)
        put("stopReason", m.stopReason.wire); put("timestamp", m.timestamp)
        m.errorMessage?.let { put("errorMessage", it) }
    }
    is ToolResultMessage -> buildJsonObject {
        put("role", "toolResult"); put("toolCallId", m.toolCallId); put("toolName", m.toolName)
        put("content", contentToJson(m.content)); put("isError", m.isError); put("timestamp", m.timestamp)
    }
    is CustomMessage -> buildJsonObject {
        put("role", "custom"); put("customType", m.customType)
        put("content", contentToJson(m.content)); put("display", m.display); put("timestamp", m.timestamp)
    }
    else -> buildJsonObject { put("role", m.role); put("timestamp", m.timestamp) }
}

private fun jsonToMessage(obj: JsonObject): AgentMessage {
    val ts = obj["timestamp"]?.jsonPrimitive?.longOrNull() ?: dev.pi.ai.nowMsPublic()
    return when (obj["role"]?.jsonPrimitive?.content) {
        "user" -> UserMessage(jsonToContent(obj["content"]!!.jsonArray), ts)
        "assistant" -> AssistantMessage(
            content = jsonToContent(obj["content"]!!.jsonArray),
            api = obj["api"]?.jsonPrimitive?.content ?: "",
            provider = obj["provider"]?.jsonPrimitive?.content ?: "",
            model = obj["model"]?.jsonPrimitive?.content ?: "",
            usage = Usage.EMPTY,
            stopReason = obj["stopReason"]?.jsonPrimitive?.content?.let { StopReason.fromWire(it) } ?: StopReason.STOP,
            errorMessage = obj["errorMessage"]?.jsonPrimitive?.contentOrNull,
            timestamp = ts,
        )
        "toolResult" -> ToolResultMessage(
            toolCallId = obj["toolCallId"]?.jsonPrimitive?.content ?: "",
            toolName = obj["toolName"]?.jsonPrimitive?.content ?: "",
            content = jsonToContent(obj["content"]!!.jsonArray),
            isError = obj["isError"]?.jsonPrimitive?.content == "true",
            timestamp = ts,
        )
        "custom" -> CustomMessage(
            customType = obj["customType"]?.jsonPrimitive?.content ?: "",
            content = jsonToContent(obj["content"]!!.jsonArray),
            display = obj["display"]?.jsonPrimitive?.content == "true",
            timestamp = ts,
        )
        else -> UserMessage(emptyList(), ts)
    }
}

private fun JsonPrimitive.longOrNull(): Long? = contentOrNull?.toLongOrNull()

private fun entryToJson(entry: SessionTreeEntry): JsonObject = buildJsonObject {
    put("type", entry.type)
    put("id", entry.id)
    put("parentId", entry.parentId?.let { JsonPrimitive(it) } ?: JsonNull)
    put("timestamp", entry.timestamp)
    when (entry) {
        is MessageEntry -> put("message", messageToJson(entry.message))
        is ThinkingLevelChangeEntry -> put("thinkingLevel", entry.thinkingLevel)
        is ModelChangeEntry -> { put("provider", entry.provider); put("modelId", entry.modelId) }
        is ActiveToolsChangeEntry -> putJsonArray("activeToolNames") { entry.activeToolNames.forEach { add(it) } }
        is CompactionEntry -> {
            put("summary", entry.summary); put("firstKeptEntryId", entry.firstKeptEntryId)
            put("tokensBefore", entry.tokensBefore)
            entry.fromHook?.let { put("fromHook", it) }
        }
        is BranchSummaryEntry -> {
            put("fromId", entry.fromId); put("summary", entry.summary)
            entry.fromHook?.let { put("fromHook", it) }
        }
        is CustomEntry -> put("customType", entry.customType)
        is CustomMessageEntry -> {
            put("customType", entry.customType); put("content", contentToJson(entry.content))
            put("display", entry.display)
        }
        is LabelEntry -> { put("targetId", entry.targetId); put("label", entry.label?.let { JsonPrimitive(it) } ?: JsonNull) }
        is SessionInfoEntry -> entry.name?.let { put("name", it) }
        is LeafEntry -> put("targetId", entry.targetId?.let { JsonPrimitive(it) } ?: JsonNull)
    }
}

private fun jsonToEntry(obj: JsonObject): SessionTreeEntry {
    val id = obj["id"]!!.jsonPrimitive.content
    val parentId = obj["parentId"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content }
    val ts = obj["timestamp"]!!.jsonPrimitive.content
    return when (obj["type"]!!.jsonPrimitive.content) {
        "message" -> MessageEntry(id, parentId, ts, jsonToMessage(obj["message"]!!.jsonObject))
        "thinking_level_change" -> ThinkingLevelChangeEntry(id, parentId, ts, obj["thinkingLevel"]!!.jsonPrimitive.content)
        "model_change" -> ModelChangeEntry(id, parentId, ts, obj["provider"]!!.jsonPrimitive.content, obj["modelId"]!!.jsonPrimitive.content)
        "active_tools_change" -> ActiveToolsChangeEntry(id, parentId, ts, obj["activeToolNames"]!!.jsonArray.map { it.jsonPrimitive.content })
        "compaction" -> CompactionEntry(
            id, parentId, ts, obj["summary"]!!.jsonPrimitive.content,
            obj["firstKeptEntryId"]!!.jsonPrimitive.content, obj["tokensBefore"]!!.jsonPrimitive.int,
            fromHook = obj["fromHook"]?.jsonPrimitive?.content?.toBoolean(),
        )
        "branch_summary" -> BranchSummaryEntry(
            id, parentId, ts, obj["fromId"]!!.jsonPrimitive.content, obj["summary"]!!.jsonPrimitive.content,
            fromHook = obj["fromHook"]?.jsonPrimitive?.content?.toBoolean(),
        )
        "custom" -> CustomEntry(id, parentId, ts, obj["customType"]!!.jsonPrimitive.content)
        "custom_message" -> CustomMessageEntry(
            id, parentId, ts, obj["customType"]!!.jsonPrimitive.content,
            jsonToContent(obj["content"]!!.jsonArray), obj["display"]!!.jsonPrimitive.content == "true",
        )
        "label" -> LabelEntry(id, parentId, ts, obj["targetId"]!!.jsonPrimitive.content, obj["label"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content })
        "session_info" -> SessionInfoEntry(id, parentId, ts, obj["name"]?.jsonPrimitive?.contentOrNull)
        "leaf" -> LeafEntry(id, parentId, ts, obj["targetId"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content })
        else -> throw SessionError(SessionErrorCode.INVALID_ENTRY, "unknown entry type")
    }
}

data class JsonlSessionMetadata(
    override val id: String,
    override val createdAt: String,
    val cwd: String,
    val path: String,
    val parentSessionPath: String? = null,
) : SessionMetadata

private fun leafIdAfterEntry(entry: SessionTreeEntry): String? =
    if (entry is LeafEntry) entry.targetId else entry.id

class JsonlSessionStorage private constructor(
    private val filePath: Path,
    private val metadata: JsonlSessionMetadata,
    entries: List<SessionTreeEntry>,
    leafId: String?,
) : SessionStorage<JsonlSessionMetadata> {
    private val entries = entries.toMutableList()
    private val byId = entries.associateBy { it.id }.toMutableMap()
    private val labelsById = mutableMapOf<String, String>().apply {
        for (e in entries) if (e is LabelEntry) {
            val label = e.label?.trim()
            if (!label.isNullOrEmpty()) put(e.targetId, label) else remove(e.targetId)
        }
    }
    private var currentLeafId = leafId

    override suspend fun getMetadata() = metadata

    override suspend fun getLeafId(): String? {
        val lid = currentLeafId
        if (lid != null && !byId.containsKey(lid)) throw SessionError(SessionErrorCode.INVALID_SESSION, "Entry $lid not found")
        return lid
    }

    override suspend fun setLeafId(leafId: String?) {
        if (leafId != null && !byId.containsKey(leafId)) throw SessionError(SessionErrorCode.NOT_FOUND, "Entry $leafId not found")
        val entry = LeafEntry(generateEntryId(byId::containsKey), currentLeafId, nowIso(), leafId)
        appendLine(entry)
        currentLeafId = leafId
    }

    override suspend fun createEntryId(): String = generateEntryId(byId::containsKey)

    override suspend fun appendEntry(entry: SessionTreeEntry) {
        appendLine(entry)
        if (entry is LabelEntry) {
            val label = entry.label?.trim()
            if (!label.isNullOrEmpty()) labelsById[entry.targetId] = label else labelsById.remove(entry.targetId)
        }
        currentLeafId = leafIdAfterEntry(entry)
    }

    private fun appendLine(entry: SessionTreeEntry) {
        Files.writeString(
            filePath,
            JSON.encodeToString(JsonElement.serializer(), entryToJson(entry)) + "\n",
            java.nio.file.StandardOpenOption.CREATE,
            java.nio.file.StandardOpenOption.APPEND,
        )
        entries.add(entry)
        byId[entry.id] = entry
    }

    override suspend fun getEntry(id: String): SessionTreeEntry? = byId[id]
    override suspend fun findEntries(type: String): List<SessionTreeEntry> = entries.filter { it.type == type }
    override suspend fun getLabel(id: String): String? = labelsById[id]
    override suspend fun getEntries(): List<SessionTreeEntry> = entries.toList()

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

    companion object {
        fun create(filePath: Path, cwd: String, sessionId: String, parentSessionPath: String? = null): JsonlSessionStorage {
            val header = buildJsonObject {
                put("type", "session"); put("version", 3); put("id", sessionId)
                put("timestamp", nowIso()); put("cwd", cwd)
                parentSessionPath?.let { put("parentSession", it) }
            }
            Files.createDirectories(filePath.parent)
            Files.writeString(filePath, JSON.encodeToString(JsonElement.serializer(), header) + "\n")
            val metadata = JsonlSessionMetadata(sessionId, header["timestamp"]!!.jsonPrimitive.content, cwd, filePath.toString(), parentSessionPath)
            return JsonlSessionStorage(filePath, metadata, emptyList(), null)
        }

        fun open(filePath: Path): JsonlSessionStorage {
            val lines = Files.readAllLines(filePath).filter { it.isNotBlank() }
            if (lines.isEmpty()) throw SessionError(SessionErrorCode.INVALID_SESSION, "missing session header")
            val header = JSON.parseToJsonElement(lines[0]).jsonObject
            if (header["type"]?.jsonPrimitive?.contentOrNull != "session") {
                throw SessionError(SessionErrorCode.INVALID_SESSION, "first line is not a valid session header")
            }
            if (header["version"]?.jsonPrimitive?.intOrNull != 3) {
                throw SessionError(SessionErrorCode.INVALID_SESSION, "unsupported session version")
            }
            val entries = mutableListOf<SessionTreeEntry>()
            var leafId: String? = null
            for (i in 1 until lines.size) {
                val entry = jsonToEntry(JSON.parseToJsonElement(lines[i]).jsonObject)
                entries.add(entry); leafId = leafIdAfterEntry(entry)
            }
            val metadata = JsonlSessionMetadata(
                header["id"]!!.jsonPrimitive.content, header["timestamp"]!!.jsonPrimitive.content,
                header["cwd"]!!.jsonPrimitive.content, filePath.toString(),
                header["parentSession"]?.jsonPrimitive?.contentOrNull,
            )
            return JsonlSessionStorage(filePath, metadata, entries, leafId)
        }
    }
}

/** Port of jsonl-repo encodeCwd + the repo over java.nio. */
internal fun encodeCwd(cwd: String): String =
    "--" + cwd.replace(Regex("^[/\\\\]"), "").replace(Regex("[/\\\\:]"), "-") + "--"

class JsonlSessionRepo(private val sessionsRoot: Path) : SessionRepo<JsonlSessionMetadata> {

    private fun sessionDir(cwd: String): Path = sessionsRoot.resolve(encodeCwd(cwd))

    private fun sessionFilePath(cwd: String, sessionId: String, timestamp: String): Path =
        sessionDir(cwd).resolve("${timestamp.replace(Regex("[:.]"), "-")}_$sessionId.jsonl")

    override suspend fun create(id: String?): Session<JsonlSessionMetadata> =
        throw UnsupportedOperationException("JsonlSessionRepo.create requires a cwd; use create(cwd, id)")

    suspend fun create(cwd: String, id: String? = null, parentSessionPath: String? = null): Session<JsonlSessionMetadata> {
        val sessionId = id ?: createSessionId()
        val createdAt = createTimestamp()
        Files.createDirectories(sessionDir(cwd))
        val storage = JsonlSessionStorage.create(sessionFilePath(cwd, sessionId, createdAt), cwd, sessionId, parentSessionPath)
        return Session(storage)
    }

    override suspend fun open(metadata: JsonlSessionMetadata): Session<JsonlSessionMetadata> {
        val path = Path.of(metadata.path)
        if (!Files.exists(path)) throw SessionError(SessionErrorCode.NOT_FOUND, "Session not found: ${metadata.path}")
        return Session(JsonlSessionStorage.open(path))
    }

    suspend fun list(cwd: String?): List<JsonlSessionMetadata> {
        val dirs = if (cwd != null) listOf(sessionDir(cwd)) else listSessionDirs()
        val sessions = mutableListOf<JsonlSessionMetadata>()
        for (dir in dirs) {
            if (!Files.exists(dir)) continue
            Files.list(dir).use { stream ->
                stream.filter { it.fileName.toString().endsWith(".jsonl") }.forEach { file ->
                    try {
                        sessions.add(JsonlSessionStorage.open(file).getMetadataBlocking())
                    } catch (e: SessionError) {
                        if (e.code != SessionErrorCode.INVALID_SESSION) throw e
                    }
                }
            }
        }
        return sessions.sortedByDescending { Instant.parse(it.createdAt) }
    }

    override suspend fun list(): List<JsonlSessionMetadata> = list(null)

    override suspend fun delete(metadata: JsonlSessionMetadata) {
        Files.deleteIfExists(Path.of(metadata.path))
    }

    override suspend fun fork(source: JsonlSessionMetadata, options: SessionForkOptions): Session<JsonlSessionMetadata> =
        throw UnsupportedOperationException("Use fork(source, cwd, options)")

    suspend fun fork(source: JsonlSessionMetadata, cwd: String, options: SessionForkOptions): Session<JsonlSessionMetadata> {
        val src = open(source)
        val forkedEntries = getEntriesToFork(src.getStorage(), options)
        val sessionId = options.id ?: createSessionId()
        val createdAt = createTimestamp()
        Files.createDirectories(sessionDir(cwd))
        val storage = JsonlSessionStorage.create(
            sessionFilePath(cwd, sessionId, createdAt), cwd, sessionId, source.path,
        )
        for (entry in forkedEntries) storage.appendEntry(entry)
        return Session(storage)
    }

    private fun listSessionDirs(): List<Path> {
        if (!Files.exists(sessionsRoot)) return emptyList()
        return Files.list(sessionsRoot).use { s -> s.filter { Files.isDirectory(it) }.toList() }
    }
}

/** Synchronous metadata read used during list() enumeration. */
private fun JsonlSessionStorage.getMetadataBlocking(): JsonlSessionMetadata =
    kotlinx.coroutines.runBlocking { getMetadata() }
