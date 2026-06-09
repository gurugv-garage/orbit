// Firmware self-update over the station link. See docs/OTA.md §4.
//
// Flow: the station publishes an `ota/available` offer on the station WS; the
// station_link event handler hands the offer payload here. station_ota:
//   1. ignores stale/non-newer offers and re-entrant offers,
//   2. runs esp_https_ota on its OWN FreeRTOS task (never blocks the WS cb),
//      streaming the URL into the inactive OTA slot, verifying sha256,
//   3. sets the boot partition and reboots into the new image,
//   4. on the NEXT boot the new image runs in pending-verify; only after the
//      station link comes fully up (station_ota_on_link_ready) do we cancel
//      rollback. If the new image can't rejoin, the bootloader reverts.
//
// Progress/result is streamed back on the `ota` topic for the console (§1).

#pragma once

#include "cJSON.h"

// Handle an `ota/available` offer payload { target, build, version, url,
// sha256, size }. Spawns the OTA task if the offer is newer than us and no OTA
// is already running. Does NOT take ownership of `offer` (copies what it needs).
void station_ota_begin(const cJSON *offer);

// Call once the station link is fully up (profile accepted). If the running
// image is a freshly-OTA'd one awaiting verification, this cancels the pending
// rollback — we've proven the new build rejoins Wi-Fi + station. Idempotent;
// a no-op for a normally-booted (already-valid) image.
void station_ota_on_link_ready(void);
