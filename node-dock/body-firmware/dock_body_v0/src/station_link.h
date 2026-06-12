// orbit-station client link — the body's ONLY socket (server-brain cutover,
// docs/SERVER-BRAIN-IMPL.md §5).
//
// The body is a WS *client* that dials orbit-station and:
//   - sends hello v2 { role:"device", dock, component:"body",
//     kind:"dock-body-fw", caps:["servo"], id, build }
//   - publishes its capability `profile` once, then `state` + a `heartbeat`
//   - obeys `command` (set_target body) frames from the station's motion
//     executor (the brain's moves, gestures, console sliders — one master)
//   - acks state-changing commands with `applied`; emits `event` for clamps
//   - trips a 30 s staleness watchdog (event:"stale") if the executor's
//     command/heartbeat stream goes silent while connected — tripwire only;
//     the body HOLDS pose (never auto-homes, DESIGN.md §5.2)
//
// The phone-facing BodyLink WS *server* (:17317) is GONE — the phone and the
// firmware never talk directly anymore. The BodyLink message *shapes* live on
// (bodylink_proto.{h,c}): the station speaks the same vocabulary over this
// socket, and a standalone-server mode remains a parked SDK idea
// (bodylink/DESIGN.md banner) — we deleted the socket, not the shape.
//
// If STATION_URL is empty or unreachable, this layer does nothing harmful —
// esp_websocket_client retries in the background; servos hold their last
// commanded pose. Spec: orbit-station/PEER-CONTRACT.md
//
// Call once after Wi-Fi has an IP. Idempotent.

#pragma once

#include "esp_err.h"
#include "cJSON.h"
#include <stdbool.h>

// Start the station client. No-op (returns ESP_OK) if STATION_URL is empty.
esp_err_t station_link_start(void);

// Publish a frame { t:"publish", topic, kind, payload } on the station link.
// Takes ownership of `payload` (frees it). No-op if not connected. Used by
// station_ota to stream OTA progress/result on the `ota` topic (docs/OTA.md §1).
void station_link_publish(const char *topic, const char *kind, cJSON *payload);

// True once the station WS is connected AND we've sent our profile — i.e. the
// link is fully usable. station_ota uses this as the "reconnected to station"
// half of the rollback-validate gate (docs/OTA.md §4.3).
bool station_link_ready(void);
