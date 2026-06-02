package dev.orbit.dock.body

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Wire-format types for the BodyLink protocol v0 (2026-05-27 redesign).
 *
 * See node-dock/bodylink/DESIGN.md for the canonical spec.
 * Every message shares the same outer envelope:
 *
 *     { "v": 0, "type": "...", "id": "...", "ts": 1731943244123, "body": { ... } }
 *
 * `id` only appears when correlation is needed (echo, snapshot). `body` is
 * an object whose shape depends on `type`. We decode the envelope first to
 * read the `type`, then dispatch to a type-specific body decoder.
 *
 * Brain ↔ Body. The dock app is the Brain. The sim or ESP32 is the Body.
 *
 * Key shift from the pre-2026-05-27 protocol:
 *   - Body advertises CAPABILITIES (parts + primitive param ranges + home pose),
 *     not named states. Named states live brain-side (see BodyStateCatalog).
 *   - Brain sends a single motion command: `set_target` — per-part idempotent,
 *     used for both immediate intent AND periodic heartbeat.
 *   - No body→brain state stream. Body only emits `event` + `error`.
 */

const val BODYLINK_PROTOCOL_VERSION = 0

/** Outer envelope. Decoded first to extract `type`, then `body` is dispatched. */
@Serializable
data class BodyEnvelope(
    val v: Int,
    val type: String,
    val id: String? = null,
    val ts: Long? = null,
    val body: JsonElement = JsonObject(emptyMap()),
)

// ── Brain → Body ─────────────────────────────────────────────────────────

/** First message from Brain on connect. Declares which protocol versions we speak. */
@Serializable
data class HelloBody(val protos: List<Int> = listOf(BODYLINK_PROTOCOL_VERSION))

/**
 * Universal motion command. Body is per-part idempotent: spamming the same
 * frame is harmless, missing one is recoverable on the next heartbeat.
 *
 * `parts` is keyed by part name (e.g. "neck", "foot"); each value is a JSON
 * object of primitive params: `{ "pulse_width_us": 1245, "duration_ms": 400 }`.
 * Unknown params produce `error: UNKNOWN_PARAM`; out-of-range values are
 * clipped to the declared range and produce `error: OUT_OF_RANGE` + an
 * `event: clipped` so the brain knows what actually happened.
 */
@Serializable
data class SetTargetBody(
    val parts: Map<String, JsonObject>,
)

/** Diagnostic latency probe. Body replies with EchoReplyBody echoing the values. */
@Serializable
data class EchoBody(
    val seq: Int,
    @SerialName("host_ts") val hostTs: Long,
)

// ── Body → Brain ─────────────────────────────────────────────────────────

/** Body's identity, sent immediately after Brain's hello. */
@Serializable
data class WelcomeBody(
    @SerialName("device_id") val deviceId: String,
    val name: String,
    @SerialName("fw_version") val fwVersion: String,
    val proto: Int,
)

/**
 * Self-describing capability profile. Replaces the old states-as-catalog
 * profile: parts now advertise primitive parameter ranges + a home pose.
 * Named states live brain-side.
 */
@Serializable
data class ProfileBody(
    @SerialName("device_id") val deviceId: String,
    val name: String,
    @SerialName("fw_version") val fwVersion: String,
    val parts: Map<String, PartCapability>,
)

@Serializable
data class PartCapability(
    val description: String = "",
    val home: Map<String, JsonElement> = emptyMap(),
    val params: Map<String, ParamSpec> = emptyMap(),
)

@Serializable
data class ParamSpec(
    val type: String,
    val unit: String = "",
    val range: List<JsonElement?> = emptyList(),
    val default: JsonElement? = null,
    val description: String = "",
)

/**
 * Async non-fatal notice. `kind` is the discriminator; extra fields are
 * kind-specific. For `clipped`, `param`/`requested`/`applied` are populated.
 */
@Serializable
data class EventBody(
    val kind: String,
    val part: String? = null,
    val param: String? = null,
    val requested: JsonElement? = null,
    val applied: JsonElement? = null,
    val source: String? = null,
)

@Serializable
data class EchoReplyBody(
    val seq: Int,
    @SerialName("host_ts") val hostTs: Long,
    @SerialName("device_ts") val deviceTs: Long,
)

/**
 * Per-message ack of a state-changing `set_target` (DESIGN.md §3.2).
 * Brain correlates by the envelope's `id`. Not emitted when every part
 * was a no-op (heartbeat resend).
 */
@Serializable
data class AppliedBody(
    val status: String,   // "applied" | "rejected"
)

@Serializable
data class ErrorBody(
    val code: String,
    val message: String = "",
    val fatal: Boolean = false,
)
