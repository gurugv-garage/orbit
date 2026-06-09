// orbit-station client link — OPTIONAL registration with the central station.
//
// This is separate from, and additive to, the phone-facing BodyLink WS *server*
// (bodylink_ws.{h,c}) on :17317, which is unchanged. Here the body acts as a WS
// *client* that dials orbit-station and:
//   - sends `hello` { role:firmware, id, dock, bodyAddr:"<our-ip>:17317" }
//   - publishes its capability `profile` once, then `state` + a `heartbeat`
//   - obeys `command` (set_target) frames from the station's bodylink console
//
// The station is OPTIONAL. If STATION_URL is empty or unreachable, this layer
// does nothing harmful — esp_websocket_client retries in the background and the
// body runs normally on its baked-in config. Spec: orbit-station/PEER-CONTRACT.md
//
// Call once after Wi-Fi has an IP. Idempotent.

#pragma once

#include "esp_err.h"
#include "esp_netif.h"
#include "cJSON.h"
#include <stdbool.h>

// Start the station client. `our_ip` is this device's STA IP (for bodyAddr).
// No-op (returns ESP_OK) if STATION_URL is empty.
esp_err_t station_link_start(esp_ip4_addr_t our_ip);

// Publish a frame { t:"publish", topic, kind, payload } on the station link.
// Takes ownership of `payload` (frees it). No-op if not connected. Used by
// station_ota to stream OTA progress/result on the `ota` topic (docs/OTA.md §1).
void station_link_publish(const char *topic, const char *kind, cJSON *payload);

// True once the station WS is connected AND we've sent our profile — i.e. the
// link is fully usable. station_ota uses this as the "reconnected to station"
// half of the rollback-validate gate (docs/OTA.md §4.3).
bool station_link_ready(void);
