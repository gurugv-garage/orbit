package dev.orbit.dock.bench

import dev.orbit.dock.llm.DockPrompt
import dev.orbit.dock.llm.DockStreamFn
import dev.pi.agent.Agent
import dev.pi.agent.AgentEvent
import dev.pi.agent.AgentListener
import dev.pi.agent.AgentOptions
import dev.pi.ai.AssistantMessage
import dev.pi.ai.ImageContent
import dev.pi.ai.Model
import dev.pi.ai.TextContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

/**
 * Drives one model through the dock's REAL request path: :dock-llm transport +
 * the real [DockToolSchemas]/[DockPrompt] + no-op [BenchTools]. One [runTurn]
 * per attempt; [runCase] does N attempts and aggregates latency + pass-rate.
 *
 * Note this benchmarks the MODEL, not our code — so each turn builds a fresh
 * Agent (clean transcript) and we record what the model emitted, never a servo.
 */
class Runner(
    private val cfg: ModelConfig,
    private val imagesDir: File,
    private val apiKey: String?,
    /** Per-turn wall-clock cap. A turn slower than this is recorded as a timeout
     *  — which is itself a "too slow for a live dock" fail (the real dock caps at
     *  60s). Lower it (e.g. 30s) for slow/loopy models so runaway cases fail fast
     *  instead of pinning N runs at 90s each. */
    private val turnTimeoutMs: Long = 90_000,
    private val log: (String) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val openAi = cfg.api.equals("openai", ignoreCase = true)
    private val provider = DockStreamFn(
        scope = scope,
        baseUrl = cfg.baseUrl,
        think = false,
        openAiStyle = openAi,
        apiKey = apiKey,
        log = log,
    )
    private val model = Model(
        id = cfg.model, name = cfg.name,
        api = if (openAi) "openai-completions" else "ollama",
        provider = if (openAi) "openai" else "ollama",
        baseUrl = cfg.baseUrl,
    )

    fun close() = provider.close()

    /** One attempt. Returns a [TurnOutcome] (errors captured, never thrown). */
    suspend fun runTurn(case: Case, timeoutMs: Long = turnTimeoutMs): TurnOutcome {
        val tools = BenchTools()
        val agent = Agent(
            AgentOptions(
                systemPrompt = DockPrompt.SYSTEM,
                model = model,
                tools = tools.tools(),
                streamFn = provider.streamFn,
            ),
        )

        var firstEventMs = -1L
        val start = System.currentTimeMillis()
        var ended = false
        var streamError: String? = null

        agent.subscribe(AgentListener { ev ->
            when (ev) {
                is AgentEvent.MessageUpdate -> if (firstEventMs < 0) firstEventMs = System.currentTimeMillis() - start
                is AgentEvent.TurnEnd -> ended = true
                else -> {}
            }
        })

        val images = case.image?.let { name ->
            val f = File(imagesDir, name)
            if (!f.exists()) { streamError = "missing image: $name"; emptyList() }
            else listOf(ImageContent(data = java.util.Base64.getEncoder().encodeToString(f.readBytes()), mimeType = "image/jpeg"))
        } ?: emptyList()

        if (streamError == null) {
            val completed = withTimeoutOrNull(timeoutMs) {
                runCatching { agent.prompt(case.prompt, images) }
                    .onFailure { streamError = it.message ?: it::class.java.simpleName }
                // wait for the loop to flush TurnEnd (prompt returns once the turn finishes)
                ended
            }
            if (completed == null) streamError = "timeout after ${timeoutMs}ms"
        }

        val total = System.currentTimeMillis() - start
        // Spoken output = all TextContent across assistant messages in the transcript.
        val output = agent.state.messages
            .filterIsInstance<AssistantMessage>()
            .flatMap { it.content }
            .filterIsInstance<TextContent>()
            .joinToString("") { it.text }
            .trim()
        // A transport/model error surfaces as an AssistantMessage.errorMessage too.
        val msgErr = agent.state.messages.filterIsInstance<AssistantMessage>()
            .firstNotNullOfOrNull { it.errorMessage }

        return TurnOutcome(
            output = output,
            toolCalls = tools.calls.toList(),
            allEnumsValid = tools.allEnumsValid,
            firstEventMs = if (firstEventMs < 0) total else firstEventMs,
            totalMs = total,
            error = streamError ?: msgErr,
        )
    }

    /** N attempts → aggregated [CaseResult]. */
    suspend fun runCase(case: Case, capability: String, n: Int): CaseResult {
        val runs = mutableListOf<RunResult>()
        for (i in 1..n) {
            val o = runTurn(case)
            val passed = Evaluate.pass(case.expect, o)
            runs.add(RunResult(passed, o.totalMs, o.firstEventMs, o.output, o.toolCalls, o.error))
            log("  [${cfg.name}] ${case.id} run $i/$n: ${if (passed) "PASS" else "fail"} ${o.totalMs}ms tools=${o.toolCalls.map { it.name }} ${o.error ?: ""}")
        }
        val passRate = runs.count { it.pass }.toDouble() / runs.size
        val withTool = runs.count { it.toolCalls.isNotEmpty() }
        val spoke = runs.count { it.output.isNotBlank() }
        val errored = runs.count { it.error != null }
        return CaseResult(
            id = case.id,
            capability = capability,
            prompt = case.prompt,
            image = case.image,
            n = n,
            passRate = passRate,
            latency = latencyStats(runs),
            objective = mapOf(
                "toolCallRate" to "$withTool/$n",
                "spokeRate" to "$spoke/$n",
                "errors" to "$errored/$n",
            ),
            runs = runs,
        )
    }

    private fun latencyStats(runs: List<RunResult>): LatencyStats {
        val ms = runs.map { it.ms }.sorted()
        val first = runs.map { it.firstEventMs }.sorted()
        if (ms.isEmpty()) return LatencyStats(0, 0, 0, 0, 0, 0)
        return LatencyStats(
            p50 = pctile(ms, 0.50), p90 = pctile(ms, 0.90),
            min = ms.first(), max = ms.last(), mean = ms.sum() / ms.size,
            firstEventP50 = pctile(first, 0.50),
        )
    }

    private fun pctile(sorted: List<Long>, q: Double): Long {
        if (sorted.isEmpty()) return 0
        val idx = Math.ceil(q * sorted.size).toInt().coerceIn(1, sorted.size) - 1
        return sorted[idx]
    }
}
