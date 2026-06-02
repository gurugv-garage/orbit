package dev.orbit.dock.agent

import android.content.Context
import dev.orbit.dock.BuildConfig

/**
 * The models the in-app picker offers — the same five the benchmark
 * ([app/bench]) characterised, so what you select is what was measured. Each
 * carries the transport config [DockAgent] needs (baseUrl / api / vision). The
 * default ([DEFAULT]) is the build's configured model; the user's pick is
 * persisted by [ModelStore] and survives restarts.
 *
 * Cloud entries need Wi-Fi + the baked OPENROUTER_API_KEY; local entries point at
 * the laptop's Ollama/llama.cpp on the LAN (only reachable on the home network).
 */
data class ModelOption(
    val label: String,        // shown in the picker
    val baseUrl: String,
    val model: String,        // wire id
    val api: String,          // "ollama" | "openai"
    val vision: Boolean,
    val cloud: Boolean,       // needs the API key + internet
)

object ModelCatalog {
    // The picker offers only the VERIFIED-GOOD models from the benchmark
    // ([app/bench]). The slow/over-eager cloud models it rejected (qwen3-vl-235b
    // loops, claude-haiku-4.5 over-moves + miscounts, minimax-m3 / glm-4.6v are
    // too slow) are deliberately NOT offered. Update this list as the bench
    // learns more (and keep bench/models.json roughly in step).
    val OPTIONS: List<ModelOption> = listOf(
        // Cloud (need Wi-Fi + an API key):
        ModelOption("gemini-2.5-flash", "https://openrouter.ai/api", "google/gemini-2.5-flash", "openai", vision = true, cloud = true),
        // Same model, DIRECT to Google (OpenAI-compat endpoint) — bypasses
        // OpenRouter. Needs GEMINI_API_KEY in local.properties.
        ModelOption("gemini-direct (Google)", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "openai", vision = true, cloud = true),
        ModelOption("gpt-4o-mini", "https://openrouter.ai/api", "openai/gpt-4o-mini", "openai", vision = true, cloud = true),
        // Local (laptop on the LAN):
        ModelOption("gemma4:e2b (local)", "http://192.168.1.10:11434", "gemma4:e2b", "ollama", vision = true, cloud = false),
        ModelOption("Qwen3.6-35B (local)", "http://192.168.1.10:8081", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", "openai", vision = false, cloud = false),
    )

    /** The build's configured default (local.properties), matched by wire id, or
     *  the first option if the configured one isn't in the catalog. */
    val DEFAULT: ModelOption =
        OPTIONS.firstOrNull { it.model == BuildConfig.OLLAMA_MODEL } ?: OPTIONS.first()

    fun byModel(wireId: String): ModelOption? = OPTIONS.firstOrNull { it.model == wireId }
}

/** Persists the user's chosen model (wire id) across restarts. */
class ModelStore(context: Context) {
    private val prefs = context.getSharedPreferences("dock_model", Context.MODE_PRIVATE)

    /** The selected option, or the build default if none chosen / unknown. */
    fun selected(): ModelOption {
        val id = prefs.getString(KEY, null) ?: return ModelCatalog.DEFAULT
        return ModelCatalog.byModel(id) ?: ModelCatalog.DEFAULT
    }

    fun select(option: ModelOption) {
        prefs.edit().putString(KEY, option.model).apply()
    }

    private companion object { const val KEY = "selected_model" }
}
