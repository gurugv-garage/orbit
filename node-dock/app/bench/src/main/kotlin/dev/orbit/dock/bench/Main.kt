package dev.orbit.dock.bench

import dev.orbit.dock.llm.DockPrompt
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant

/**
 * Benchmark CLI. Loads readable data files, drives each model through the dock's
 * real path N times per case, writes results JSON for viewer.html.
 *
 *   ./gradlew :bench:run --args="--models local --n 10"
 *   ./gradlew :bench:run --args="--models all --n 3 --cases tool_calling,vision"
 *
 * Flags:
 *   --models  local | cloud | all | <name,name>   (default: local)
 *   --n       runs per case (overrides per-case n)  (default: 5)
 *   --cases   capability or case-id filter (comma list; substring match)
 *   --root    bench/ dir (default: ./bench, falls back to ./app/bench)
 */
fun main(args: Array<String>) = runBlocking {
    val opts = parseArgs(args)
    val root = resolveRoot(opts["root"])
    val json = Json { ignoreUnknownKeys = true; prettyPrint = true; encodeDefaults = true }

    val models = loadModels(File(root, "models.json"), json)
    val cases = loadCases(File(root, "cases"), json)
    if (models.isEmpty()) { System.err.println("no models in ${root}/models.json"); return@runBlocking }
    if (cases.isEmpty()) { System.err.println("no cases in ${root}/cases/"); return@runBlocking }

    // --rescore: re-evaluate the STORED runs in latest.json against the current
    // case predicates and rewrite (no model calls). Use after tightening a
    // predicate so the numbers reflect the same captured outputs.
    if (opts.containsKey("rescore")) { rescore(File(root, "results"), cases, json); return@runBlocking }

    val selModels = filterModels(models, opts["models"] ?: "local")
    val caseFilter = opts["cases"]?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }
    val nOverride = opts["n"]?.toIntOrNull()
    val turnTimeoutMs = opts["turnTimeout"]?.toLongOrNull()?.times(1000) ?: 90_000L  // arg in seconds
    val imagesDir = File(root, "images")

    // Tee every log line to a timestamped results/<ts>.log so the full transport
    // + per-run trace is kept for debugging alongside the structured JSON.
    val startedTs = Instant.now().toString()
    val tee = Tee(File(File(root, "results").apply { mkdirs() }, "${startedTs.replace(":", "-")}.log"))
    tee.line("bench start $startedTs · root=${root.absolutePath} · models=${selModels.joinToString { it.name }} · n=${nOverride ?: "per-case"}")
    tee.line("Cases: ${cases.sumOf { it.second.size }} across ${cases.map { it.first }.distinct().size} capabilities\n")

    val modelResults = mutableListOf<ModelResult>()
    for (m in selModels) {
        tee.line("══ ${m.name} (${m.api}, vision=${m.vision}) ══")
        val apiKey = m.apiKeyEnv?.let { System.getenv(it) }
        if (m.apiKeyEnv != null && apiKey.isNullOrBlank()) {
            tee.line("  ⏭  skipped — env ${m.apiKeyEnv} not set"); continue
        }
        val runner = Runner(m, imagesDir, apiKey, turnTimeoutMs = turnTimeoutMs, log = { tee.line(it) })
        val caseResults = mutableListOf<CaseResult>()
        try {
            for ((capability, group) in cases) for (case in group) {
                if (caseFilter != null && caseFilter.none { capability.contains(it) || case.id.contains(it) }) continue
                // Skip vision cases for blind models.
                if (case.image != null && !m.vision) {
                    tee.line("  ⏭  ${case.id} — model has no vision"); continue
                }
                val n = nOverride ?: case.n ?: (if (m.tier == "cloud") 3 else 5)
                caseResults.add(runner.runCase(case, capability, n))
            }
        } finally {
            runner.close()
        }
        // issues are hand-assigned after review (like quality) — default empty here.
        modelResults.add(ModelResult(m.name, m.model, m.api, m.vision, m.tier, m.cost, cases = caseResults))
    }

    // A snapshot is a NAMED, durable results file (results/<snapshot>.json). It
    // embeds the exact system prompt + tool schemas used, so re-running with a
    // changed prompt produces a separate, comparable snapshot (old vs new). Pass
    // --snapshot <name>; defaults to a timestamp. --merge accumulates into the
    // SAME snapshot by model name (so llama.cpp + ollama + cloud, which can't run
    // together, build one matrix). latest.json mirrors the most recent write.
    val resultsDir = File(root, "results")
    val snapshot = opts["snapshot"] ?: startedTs.replace(":", "-")
    val priorModels = if (opts.containsKey("merge")) loadSnapshotModels(resultsDir, snapshot, json) else emptyList()
    val mergedByName = LinkedHashMap<String, ModelResult>()
    priorModels.forEach { mergedByName[it.name] = it }
    modelResults.forEach { mergedByName[it.name] = it }   // new run wins

    val result = BenchResult(
        run = RunMeta(
            snapshot = snapshot,
            ts = Instant.now().toString(),
            host = hostName(),
            note = opts["note"],
            systemPrompt = DockPrompt.SYSTEM,
            toolSchemas = BenchTools().tools().associate { it.name to it.parameters.toString() },
        ),
        models = mergedByName.values.toList(),
    )
    writeResults(resultsDir, result, snapshot, json, tee)
    tee.close()
}

/** Writes every line to stdout AND a log file, so the full run trace (transport
 *  POSTs + per-run pass/fail/latency/tools) is kept for debugging next to the JSON. */
private class Tee(file: File) {
    private val w = file.bufferedWriter()
    fun line(s: String) { println(s); w.appendLine(s); w.flush() }
    fun close() = w.close()
}

/** Re-evaluate stored runs against current case predicates (no model calls). */
private fun rescore(dir: File, cases: List<Pair<String, List<Case>>>, json: Json) {
    val f = File(dir, "latest.json")
    if (!f.exists()) { System.err.println("no latest.json to rescore"); return }
    val prior = json.decodeFromString(BenchResult.serializer(), f.readText())
    val expectById = cases.flatMap { it.second }.associateBy({ it.id }, { it.expect })

    val rescored = prior.models.map { m ->
        m.copy(cases = m.cases.map { c ->
            val expect = expectById[c.id] ?: return@map c
            val runs = c.runs.map { r ->
                val o = TurnOutcome(
                    output = r.output,
                    toolCalls = r.toolCalls,
                    allEnumsValid = r.toolCalls.all { enumsOk(it) },
                    firstEventMs = r.firstEventMs, totalMs = r.ms, error = r.error,
                )
                r.copy(pass = Evaluate.pass(expect, o))
            }
            c.copy(passRate = runs.count { it.pass }.toDouble() / runs.size, runs = runs)
        })
    }
    val out = prior.copy(models = rescored)
    val text = json.encodeToString(BenchResult.serializer(), out)
    f.writeText(text)
    // Rewrite the snapshot's own file too (latest.json is just a mirror).
    val safe = out.run.snapshot.replace(Regex("[^A-Za-z0-9._-]"), "_")
    File(dir, "$safe.json").writeText(text)
    println("✔ rescored snapshot '${out.run.snapshot}' against current predicates")
    for (m in out.models) { println(m.name); for (c in m.cases) println("  ${c.capability.padEnd(20)} ${c.id.padEnd(18)} ${pctOf(c.passRate)}") }
}

/** True if a stored tool call uses a valid part↔state pair (or isn't a move tool). */
private fun enumsOk(tc: ToolCallRecord): Boolean {
    val v = dev.orbit.dock.llm.DockToolSchemas.VALID
    return when (tc.name) {
        "move_body" -> {
            val m = Regex("\"part\"\\s*:\\s*\"(\\w+)\".*?\"state\"\\s*:\\s*\"(\\w+)\"").find(tc.args)
                ?: return false
            m.groupValues[2] in (v[m.groupValues[1]] ?: emptyList())
        }
        "gesture" -> Regex("\"name\"\\s*:\\s*\"(\\w+)\"").find(tc.args)?.groupValues?.get(1) in dev.orbit.dock.llm.DockToolSchemas.GESTURES.keys
        else -> true
    }
}

/** Prior models in the SAME snapshot file (for --merge), or empty if new. */
private fun loadSnapshotModels(dir: File, snapshot: String, json: Json): List<ModelResult> {
    val safe = snapshot.replace(Regex("[^A-Za-z0-9._-]"), "_")
    val f = File(dir, "$safe.json")
    if (!f.exists()) return emptyList()
    return runCatching { json.decodeFromString(BenchResult.serializer(), f.readText()).models }.getOrDefault(emptyList())
}

// ── loading ──────────────────────────────────────────────────────────────────

private fun loadModels(f: File, json: Json): List<ModelConfig> =
    if (!f.exists()) emptyList() else json.decodeFromString(f.readText())

/** Returns (capability, cases) pairs, one per JSON file in cases/, sorted by name. */
private fun loadCases(dir: File, json: Json): List<Pair<String, List<Case>>> {
    if (!dir.isDirectory) return emptyList()
    return dir.listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
        .map { val cf: CaseFile = json.decodeFromString(it.readText()); cf.capability to cf.cases }
}

private fun filterModels(all: List<ModelConfig>, sel: String): List<ModelConfig> = when (sel) {
    "all" -> all
    "local", "cloud" -> all.filter { it.tier == sel }
    else -> { val names = sel.split(",").map { it.trim() }; all.filter { it.name in names } }
}

// ── output ───────────────────────────────────────────────────────────────────

private fun writeResults(dir: File, result: BenchResult, snapshot: String, json: Json, tee: Tee) {
    dir.mkdirs()
    val safe = snapshot.replace(Regex("[^A-Za-z0-9._-]"), "_")
    val out = File(dir, "$safe.json")
    val text = json.encodeToString(BenchResult.serializer(), result)
    out.writeText(text)
    File(dir, "latest.json").writeText(text)        // viewer's default load
    writeIndex(dir, json)                            // snapshot list for the dropdown
    tee.line("\n✔ wrote snapshot '${snapshot}' → ${out.name} (+ latest.json)")
    // Console summary matrix.
    tee.line("\n── pass-rate summary ──")
    for (m in result.models) {
        tee.line(m.name)
        for (c in m.cases) tee.line("  ${c.capability.padEnd(20)} ${c.id.padEnd(18)} ${pctOf(c.passRate)}  p50=${c.latency.p50}ms first=${c.latency.firstEventP50}ms")
    }
}

/** index.json = list of snapshot files (+ their meta), so the viewer can offer a
 *  dropdown and a compare-two mode without directory listing. */
private fun writeIndex(dir: File, json: Json) {
    val snaps = dir.listFiles { f -> f.extension == "json" && f.name != "latest.json" && f.name != "index.json" }
        ?.sortedByDescending { it.lastModified() }
        ?.mapNotNull { f ->
            runCatching {
                val r = json.decodeFromString(BenchResult.serializer(), f.readText()).run
                SnapshotEntry(file = f.name, snapshot = r.snapshot, ts = r.ts, note = r.note)
            }.getOrNull()
        } ?: emptyList()
    File(dir, "index.json").writeText(json.encodeToString(kotlinx.serialization.builtins.ListSerializer(SnapshotEntry.serializer()), snaps))
}

private fun pctOf(d: Double) = "${Math.round(d * 100)}%".padStart(4)

private fun hostName(): String = runCatching { java.net.InetAddress.getLocalHost().hostName }.getOrDefault("unknown")

// ── args ─────────────────────────────────────────────────────────────────────

private fun parseArgs(args: Array<String>): Map<String, String> {
    val m = mutableMapOf<String, String>()
    var i = 0
    while (i < args.size) {
        val a = args[i]
        if (a.startsWith("--")) {
            val key = a.removePrefix("--")
            val v = args.getOrNull(i + 1)
            if (v != null && !v.startsWith("--")) { m[key] = v; i += 2 } else { m[key] = "true"; i += 1 }
        } else i += 1
    }
    return m
}

private fun resolveRoot(explicit: String?): File {
    explicit?.let { return File(it) }
    // `:bench:run` sets workingDir to the module dir, so "." is the bench root.
    // The others let it run from app/ or the repo root too.
    return sequenceOf(File("."), File("bench"), File("app/bench"))
        .firstOrNull { File(it, "models.json").exists() } ?: File(".")
}
