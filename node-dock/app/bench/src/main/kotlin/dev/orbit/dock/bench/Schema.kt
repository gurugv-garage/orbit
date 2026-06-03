package dev.orbit.dock.bench

import kotlinx.serialization.Serializable

// ─────────────────────────────────────────────────────────────────────────────
// Inputs: the readable data files the harness loads.
//   bench/models.json  → ModelConfig[]
//   bench/cases/*.json → CaseFile (a group of Cases)
// ─────────────────────────────────────────────────────────────────────────────

/** One model under test. `api` selects the transport dialect in :dock-llm. */
@Serializable
data class ModelConfig(
    val name: String,                 // display name, e.g. "gemma4:e2b"
    val model: String,                // wire model id sent to the server
    val baseUrl: String,              // http://host:port (no path)
    val api: String,                  // "ollama" (NDJSON) | "openai" (SSE)
    val vision: Boolean = false,      // does it accept images? (gates vision cases)
    /** "local" or "cloud" — selects via --models and sets the default N. */
    val tier: String = "local",
    /** Env var holding the bearer token (OpenRouter), or null for no auth. */
    val apiKeyEnv: String? = null,
    /** Approx cost, shown in the viewer header. "free" for local; for cloud the
     *  OpenRouter per-token price, e.g. "$0.30/$2.50 /Mtok". Informational. */
    val cost: String = "free",
)

/** A file under bench/cases/ — a named group of cases (one capability). */
@Serializable
data class CaseFile(
    val capability: String,
    val cases: List<Case>,
)

/** One benchmark case: a prompt (+ optional image) and what counts as a pass. */
@Serializable
data class Case(
    val id: String,
    val prompt: String,
    /** File name under bench/images/, or null for text-only cases. */
    val image: String? = null,
    val expect: Expect,
    /** Per-case override of run count; else the tier default (--n). */
    val n: Int? = null,
    /** Free-text note shown in the viewer to explain what's being tested. */
    val note: String? = null,
)

/**
 * A small tagged predicate set — the runner maps each present field to a check;
 * ALL present fields must hold for a run to pass.
 *  - tool=="any"            → at least one tool call emitted
 *  - toolName=="move_body"  → a tool call with that name
 *  - minToolCalls=2         → ≥2 tool calls
 *  - noTool=true            → NO tool call at all (strict chat-only)
 *  - noMove=true            → no BODY-MOVEMENT call (move_body/gesture/move_sequence);
 *                             an expressive set_face during chat is allowed/desirable
 *  - keywords=["dog"]       → output text contains ≥1 keyword (case-insensitive)
 *  - nonEmptySpeech=true    → non-empty spoken text
 *  - minSpeechChars=40      → spoken text ≥ N chars — catches "announce-then-stop"
 *                             (it promises a poem/joke but only says "here's a poem")
 *  - validEnums=true        → every move tool call uses a valid part↔state pair
 */
@Serializable
data class Expect(
    val tool: String? = null,
    val toolName: String? = null,
    val minToolCalls: Int? = null,
    val noTool: Boolean? = null,
    val noMove: Boolean? = null,
    val keywords: List<String>? = null,
    val nonEmptySpeech: Boolean? = null,
    val minSpeechChars: Int? = null,
    val validEnums: Boolean? = null,
    /**
     * Degrees check: the `move` call has at least one step on `part` whose
     * `degrees` lands in [lo, hi]. Tests that the model picks a sensible angle
     * for the asked direction/amount (e.g. "look fully up" → neck near -25).
     * null = unchecked.
     */
    val degRange: DegRange? = null,
    /** Minimum number of steps in the `move` call — tests sequencing/composition. */
    val minSteps: Int? = null,
)

/** Expected degrees window for a `move` step on a given part. */
@Serializable
data class DegRange(val part: String, val lo: Double, val hi: Double)

// ─────────────────────────────────────────────────────────────────────────────
// Outputs: bench/results/<ts>.json (+ latest.json), read by viewer.html.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class BenchResult(
    val run: RunMeta,
    val models: List<ModelResult>,
)

/**
 * A snapshot is self-describing: it embeds the EXACT model-facing surface used
 * (system prompt + tool schemas) so two snapshots taken with different prompts
 * are comparable and you can see what changed. Named (not overwritten) so runs
 * accumulate as durable history.
 */
@Serializable
data class RunMeta(
    val snapshot: String,          // human name, e.g. "prompt-v2" or a timestamp
    val ts: String,
    val host: String,
    val note: String? = null,
    /** The exact system prompt sent to every model this run. */
    val systemPrompt: String = "",
    /** The tool schemas advertised (name → JSON schema string), for the record. */
    val toolSchemas: Map<String, String> = emptyMap(),
)

@Serializable
data class ModelResult(
    val name: String,
    val model: String,
    val api: String,
    val vision: Boolean,
    val tier: String,
    val cost: String = "free",
    /** Known weaknesses Claude observed for THIS model in THIS snapshot (e.g.
     *  "over-eager movement on chat", "miscounts fingers"). Surfaced per-column
     *  in the viewer so a model's caveats travel with its numbers. Empty = no
     *  notable issues found. */
    val issues: List<String> = emptyList(),
    val cases: List<CaseResult>,
)

@Serializable
data class CaseResult(
    val id: String,
    val capability: String,
    val prompt: String,
    val image: String? = null,
    val n: Int,
    val passRate: Double,
    val latency: LatencyStats,
    val objective: Map<String, String> = emptyMap(),
    val runs: List<RunResult>,
    /** Quality badge (the SECOND badge next to pass-rate): Claude reviews the
     *  recorded outputs and writes a 1-5 grade + notes. A green 100% pass-rate
     *  can still be low quality (e.g. announces a poem but never says it). */
    var quality: Quality? = null,
)

@Serializable
data class LatencyStats(
    val p50: Long, val p90: Long, val min: Long, val max: Long, val mean: Long,
    /** ms to the FIRST event (Start / first delta) — the number users feel. */
    val firstEventP50: Long,
)

@Serializable
data class RunResult(
    val pass: Boolean,
    val ms: Long,                 // total turn time
    val firstEventMs: Long,       // time to first streamed event
    val output: String,           // spoken text the model produced
    val toolCalls: List<ToolCallRecord>,
    val error: String? = null,
)

@Serializable
data class ToolCallRecord(val name: String, val args: String)

/** Claude's quality grade for a case: 1 (broken) … 5 (excellent), + why. */
@Serializable
data class Quality(val score: Int? = null, val notes: String? = null)

/** One line in results/index.json — lets the viewer list/compare snapshots. */
@Serializable
data class SnapshotEntry(val file: String, val snapshot: String, val ts: String, val note: String? = null)
