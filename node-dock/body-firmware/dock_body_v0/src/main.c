// dock_body_v0 — ESP-IDF firmware for the BodyLink dock body.
//
// Boot order:
//   1. NVS init (esp_wifi requires it, even when we use WIFI_STORAGE_RAM).
//   2. Servos: hold all 4 at center so the PWM lines are settled before
//      Wi-Fi negotiation.
//   3. Wi-Fi STA. On IP acquired, the on_got_ip callback starts the
//      BodyLink WS server (and the motion-tick task).
//   4. app_main idles forever; everything else runs on FreeRTOS tasks.
//
// Layer map:
//   servo.{h,c}            — mcpwm PWM, 4 servos on GPIO 3/4/5/6
//   wifi_sta.{h,c}         — STA join, retry, GOT_IP callback
//   bodylink_proto.{h,c}   — JSON envelope encode/decode (cJSON)
//   bodylink_motion.{h,c}  — capability profile, set_param/set_target, motion tick
//   bodylink_ws.{h,c}      — esp_http_server WS dispatcher + tick task
//
// Spec: ../../bodylink/DESIGN.md

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "servo.h"
#include "wifi_sta.h"
#include "bodylink_motion.h"
#include "bodylink_ws.h"
#include "station_link.h"

static const char *TAG = "main";

static void on_got_ip(esp_ip4_addr_t ip) {
    bl_ws_start();                  // phone-facing BodyLink server (:17317)
    station_link_start(ip);         // optional client registration with orbit-station
}

void app_main(void) {
    ESP_LOGI(TAG, "── dock_body_v0 (ESP-IDF BodyLink) ──");

    // NVS — required by esp_wifi's internal bookkeeping.
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(r);
    }

    // Servos first. PWM running, all 4 holding 1500 µs (center) before
    // anything else happens. Then init the BodyLink runtime, which also
    // parks each *advertised* part at its home pose (currently same as
    // center, but the indirection matters once homes diverge).
    ESP_ERROR_CHECK(servo_init_all());
    ESP_ERROR_CHECK(bl_motion_init());

#ifndef BL_DISABLE_WIFI
    ESP_ERROR_CHECK(wifi_sta_start(on_got_ip));
    if (wifi_sta_wait_connected(portMAX_DELAY)) {
        ESP_LOGI(TAG, "✅ Wi-Fi up; BodyLink WS ready on :17317");
    } else {
        ESP_LOGE(TAG, "❌ Wi-Fi failed; body running offline (servos still active)");
    }
#else
    ESP_LOGW(TAG, "Wi-Fi DISABLED at compile time (BL_DISABLE_WIFI). Servos only.");
#endif

    // Idle: all real work is on tasks.
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
