// BodyLink WebSocket layer — esp_http_server + dispatch + single-client
// enforcement + the 10 ms motion tick task.
//
// Owns the HTTP server lifecycle. Call once after Wi-Fi is up.

#pragma once

#include "esp_err.h"

// Start the HTTP server (port 17317) and spawn the motion tick task.
// Idempotent — safe to call multiple times.
esp_err_t bl_ws_start(void);

// Stop the HTTP server. (Not currently used; provided for completeness.)
esp_err_t bl_ws_stop(void);
