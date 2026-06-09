// Firmware self-update over the station link. See station_ota.h + docs/OTA.md §4.

#include "station_ota.h"

#include <string.h>
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_format.h"
#include "esp_https_ota.h"
#include "esp_http_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

#include "station_link.h"   // station_link_publish / station_link_ready
#include "version.h"        // BL_FW_BUILD

static const char *TAG = "station_ota";

// One OTA at a time. Set when the task is spawned, cleared when it exits.
static volatile bool s_ota_running = false;

// The offer, copied off the cJSON before the WS callback frees it.
typedef struct {
    int  build;
    char url[256];
    char sha256[65];   // 64 hex + NUL
} ota_offer_t;

// ── progress reporting on the `ota` topic (console phase bar) ──────────────

static void report_progress(const char *phase, int pct) {
    cJSON *p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "target", "body");
    cJSON_AddStringToObject(p, "phase", phase);
    if (pct >= 0) cJSON_AddNumberToObject(p, "pct", pct);
    station_link_publish("ota", "progress", p);
}

static void report_result(int build, bool ok, const char *err) {
    cJSON *p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "target", "body");
    cJSON_AddNumberToObject(p, "build", build);
    cJSON_AddBoolToObject(p, "ok", ok);
    if (err) cJSON_AddStringToObject(p, "error", err);
    station_link_publish("ota", "result", p);
}

// ── sha256 verify of the image just written to the inactive slot ───────────

static bool verify_slot_sha256(const esp_partition_t *part, size_t image_len,
                               const char *want_hex) {
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0 /* SHA-256, not 224 */);

    static uint8_t buf[1024];
    size_t off = 0;
    while (off < image_len) {
        size_t n = image_len - off;
        if (n > sizeof(buf)) n = sizeof(buf);
        if (esp_partition_read(part, off, buf, n) != ESP_OK) {
            mbedtls_sha256_free(&ctx);
            return false;
        }
        mbedtls_sha256_update(&ctx, buf, n);
        off += n;
    }
    uint8_t digest[32];
    mbedtls_sha256_finish(&ctx, digest);
    mbedtls_sha256_free(&ctx);

    char got_hex[65];
    for (int i = 0; i < 32; ++i) snprintf(got_hex + i * 2, 3, "%02x", digest[i]);
    return strcasecmp(got_hex, want_hex) == 0;
}

// ── the OTA task ───────────────────────────────────────────────────────────

static void ota_task(void *arg) {
    ota_offer_t *off = (ota_offer_t *)arg;
    esp_err_t err;

    ESP_LOGI(TAG, "OTA start: build %d <- %s", off->build, off->url);

    esp_http_client_config_t http_cfg = {
        .url = off->url,
        .timeout_ms = 20000,
        .keep_alive_enable = true,
    };
    esp_https_ota_config_t ota_cfg = {
        .http_config = &http_cfg,
    };

    esp_https_ota_handle_t handle = NULL;
    err = esp_https_ota_begin(&ota_cfg, &handle);
    if (err != ESP_OK || handle == NULL) {
        ESP_LOGE(TAG, "ota_begin failed: %s", esp_err_to_name(err));
        report_result(off->build, false, "ota_begin failed");
        goto done;
    }

    report_progress("downloading", -1);
    int image_total = esp_https_ota_get_image_size(handle);   // -1 if unknown
    int last_pct = -1;
    while (1) {
        err = esp_https_ota_perform(handle);
        if (err != ESP_ERR_HTTPS_OTA_IN_PROGRESS) break;
        int got = esp_https_ota_get_image_len_read(handle);
        if (image_total > 0) {
            int pct = (int)((int64_t)got * 100 / image_total);
            if (pct != last_pct && (pct % 10 == 0)) {   // throttle to every ~10%
                last_pct = pct;
                report_progress("downloading", pct);
            }
        }
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ota_perform failed: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        report_result(off->build, false, "download failed");
        goto done;
    }
    if (!esp_https_ota_is_complete_data_received(handle)) {
        ESP_LOGE(TAG, "incomplete image received");
        esp_https_ota_abort(handle);
        report_result(off->build, false, "incomplete image");
        goto done;
    }

    // ── verify sha256 against the slot the image just landed in ───────────
    report_progress("verifying", -1);
    {
        const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
        size_t image_len = (size_t)esp_https_ota_get_image_len_read(handle);
        if (!next || !verify_slot_sha256(next, image_len, off->sha256)) {
            ESP_LOGE(TAG, "sha256 mismatch — refusing to boot this image");
            esp_https_ota_abort(handle);   // do NOT set boot partition
            report_result(off->build, false, "sha256 mismatch");
            goto done;
        }
    }

    // ── finish: validates header, sets boot partition to the new slot ─────
    report_progress("applying", -1);
    err = esp_https_ota_finish(handle);
    handle = NULL;
    if (err != ESP_OK) {
        // ESP_ERR_OTA_VALIDATE_FAILED here means the image header was bad.
        ESP_LOGE(TAG, "ota_finish failed: %s", esp_err_to_name(err));
        report_result(off->build, false, "finish/validate failed");
        goto done;
    }

    // The new image is now the boot partition, in pending-verify. On reboot it
    // runs; station_ota_on_link_ready() cancels rollback once it rejoins. If it
    // can't, the bootloader reverts to this (last-good) image.
    ESP_LOGI(TAG, "OTA written; rebooting into build %d", off->build);
    report_progress("rebooting", -1);
    vTaskDelay(pdMS_TO_TICKS(300));   // let the publish flush
    esp_restart();
    // not reached

done:
    if (handle) esp_https_ota_abort(handle);
    free(off);
    s_ota_running = false;
    vTaskDelete(NULL);
}

// ── public ─────────────────────────────────────────────────────────────────

void station_ota_begin(const cJSON *offer) {
    if (s_ota_running) {
        ESP_LOGW(TAG, "OTA already in progress — ignoring offer");
        return;
    }
    const cJSON *jbuild = cJSON_GetObjectItemCaseSensitive(offer, "build");
    const cJSON *jurl   = cJSON_GetObjectItemCaseSensitive(offer, "url");
    const cJSON *jsha   = cJSON_GetObjectItemCaseSensitive(offer, "sha256");
    if (!cJSON_IsNumber(jbuild) || !cJSON_IsString(jurl) || !cJSON_IsString(jsha)) {
        ESP_LOGW(TAG, "malformed ota/available offer — ignoring");
        return;
    }

    int build = jbuild->valueint;
    // Refuse non-newer offers (defence in depth; the station gates too). A
    // device only ever moves toward a STRICTLY greater build (docs/OTA.md §3.4).
    if (build <= BL_FW_BUILD) {
        ESP_LOGI(TAG, "offer build %d <= running %d — skipping", build, BL_FW_BUILD);
        return;
    }
    if (strlen(jsha->valuestring) != 64) {
        ESP_LOGW(TAG, "ota offer sha256 not 64 hex chars — ignoring");
        return;
    }

    ota_offer_t *off = calloc(1, sizeof(*off));
    if (!off) return;
    off->build = build;
    snprintf(off->url, sizeof(off->url), "%s", jurl->valuestring);
    snprintf(off->sha256, sizeof(off->sha256), "%s", jsha->valuestring);

    s_ota_running = true;
    // 8 KB stack: esp_https_ota + mbedTLS SHA need headroom.
    if (xTaskCreate(ota_task, "ota_task", 8192, off, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "failed to spawn ota_task");
        free(off);
        s_ota_running = false;
    }
}

void station_ota_on_link_ready(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;
    if (state != ESP_OTA_IMG_PENDING_VERIFY) return;   // normal boot — nothing to do

    // We're a freshly-OTA'd image and the station link just came fully up:
    // the new build demonstrably rejoins Wi-Fi + station. Confirm it good so
    // the bootloader stops watching for rollback.
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        ESP_LOGI(TAG, "new image validated (rollback cancelled), build %d", BL_FW_BUILD);
        report_result(BL_FW_BUILD, true, NULL);   // phase: done, confirmed
        report_progress("done", 100);
    } else {
        ESP_LOGE(TAG, "mark_app_valid failed");
    }
}
