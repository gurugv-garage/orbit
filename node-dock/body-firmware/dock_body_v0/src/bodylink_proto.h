// BodyLink wire-protocol encode/decode.
//
// Pure data layer. No FreeRTOS, no HTTPD, no globals. Caller owns lifetimes.
//
// Encoders return a malloc'd NUL-terminated JSON string. Caller frees with
// free(). Decoders take an input span + return parsed cJSON* (also caller-
// freed via cJSON_Delete) or a typed struct.
//
// Wire spec: ../../bodylink/DESIGN.md

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "cJSON.h"
#include "version.h"   // BL_FW_VERSION + BL_FW_BUILD — single source of truth (docs/OTA.md §3.2)

#define BL_PROTOCOL_VERSION   0
#define BL_WS_PORT            17317

// Fallback instance id — station_link overwrites it with the MAC-derived
// "body-xxxxxx" at startup (hello v2: `id` names the hardware; two boards in
// a house must never share it).
#define BL_DEVICE_ID          "body-unknown"
#define BL_DEVICE_NAME        "dock-body"

// ── Encoders (return malloc'd string, caller frees) ─────────────────────

// event { kind: "boot" }
char *bl_enc_event_boot(int ts);

// event { kind: "clipped", part, param, requested, applied }
char *bl_enc_event_clipped(int ts, const char *part, const char *param,
                           double requested, double applied);

// welcome { device_id, name, fw_version, proto }
char *bl_enc_welcome(int ts);

// profile { device_id, name, fw_version, parts: {...} }
// `parts_json` is a cJSON object (the encoder takes ownership and deletes
// it after serialization). Build it with bl_build_profile_parts() below.
char *bl_enc_profile(int ts, cJSON *parts_json);

// Build the parts object for a profile message. Each part has its own
// entry produced by bl_build_part(); add via cJSON_AddItemToObject().
cJSON *bl_build_part(const char *description, int home_pulse_us,
                     cJSON *params_json);

// Build a single param spec object (added under part.params[name]).
// range_lo / range_hi: pass NaN for unbounded; default_val: NaN for none.
cJSON *bl_build_param_spec(const char *type, const char *unit,
                           double range_lo, double range_hi,
                           double default_val,
                           const char *description);

// error { code, message, fatal }
char *bl_enc_error(int ts, const char *code, const char *message, bool fatal);

// echo_reply { id, body: {seq, host_ts, device_ts} }
char *bl_enc_echo_reply(const char *id, int ts,
                        int seq, long long host_ts, long long device_ts);

// applied { id, body: {status} } — per-message ack of a state-changing
// set_target. `id` may be NULL (brain didn't correlate). `status` is
// "applied" (motion started for ≥1 part) or "rejected" (frame structurally
// invalid). See DESIGN.md §3.2.
char *bl_enc_applied(const char *id, int ts, const char *status);

// ── Decoders ────────────────────────────────────────────────────────────

// Parse a raw WS payload. Caller owns the returned cJSON* (free via
// cJSON_Delete). NULL on malformed JSON.
cJSON *bl_parse(const char *payload, size_t len);

// Read envelope.v (returns -1 if missing / not int).
int bl_env_v(const cJSON *env);

// Read envelope.type (returns NULL if missing). String is owned by env.
const char *bl_env_type(const cJSON *env);

// Read envelope.id (NULL if absent). String is owned by env.
const char *bl_env_id(const cJSON *env);

// Read envelope.body (NULL if absent or not an object). Owned by env.
cJSON *bl_env_body(cJSON *env);

// True if hello.body.protos contains 0. False on any malformedness.
bool bl_hello_offers_v0(const cJSON *body);
