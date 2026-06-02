// Wi-Fi STA bring-up — native esp_wifi, event-driven, with retry.
//
// Behavior:
//   - PMF capable (not required) — fixes the 4-way-handshake interop
//     issue that arduino-esp32 had with the Airtel ONT.
//   - Power-save off during bring-up.
//   - On disconnect: log reason code (decoded), retry up to kMaxRetries.
//   - On IP acquired: invoke the user's `on_got_ip` callback.
//
// SSID + password come from include/secrets.h. The header purposely
// stays narrow — the caller doesn't get to override the credentials per
// call. Change secrets.h.
//
// Usage:
//   wifi_sta_start(my_on_got_ip);   // returns immediately; callback fires async
//   wifi_sta_wait_connected(portMAX_DELAY);   // optional: block until up or failed

#pragma once

#include "esp_err.h"
#include "esp_netif_ip_addr.h"
#include "freertos/FreeRTOS.h"

// Callback invoked once Wi-Fi reaches IP_EVENT_STA_GOT_IP. Runs on the
// default event-loop task — keep handlers short, no blocking I/O.
typedef void (*wifi_sta_on_got_ip_t)(esp_ip4_addr_t ip);

// Bring up STA. Blocks briefly to init; returns once esp_wifi_start has
// fired and event handlers are registered. Subsequent activity is async.
esp_err_t wifi_sta_start(wifi_sta_on_got_ip_t on_got_ip);

// Wait for either CONNECTED or FAIL. Returns true if connected, false if
// the retry budget was exhausted. ticks_to_wait can be portMAX_DELAY.
bool wifi_sta_wait_connected(TickType_t ticks_to_wait);
