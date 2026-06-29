// dock_body_v0 — ESP-IDF firmware for the dock body (orbit-station client).
//
// Boot order:
//   1. NVS init (esp_wifi requires it, even when we use WIFI_STORAGE_RAM).
//   2. Servos: hold all 4 at center so the PWM lines are settled before
//      Wi-Fi negotiation.
//   3. Motion tick task (100 Hz) — runs regardless of connectivity, so the
//      body settles transitions and holds pose even fully offline.
//   4. Wi-Fi STA. On IP acquired, the on_got_ip callback dials orbit-station
//      (the body's ONLY socket — the phone-facing BodyLink server is gone;
//      docs/SERVER-BRAIN-IMPL.md §5).
//   5. app_main idles forever; everything else runs on FreeRTOS tasks.
//
// Layer map:
//   servo.{h,c}            — mcpwm PWM, 4 servos on GPIO 3/4/5/6
//   wifi_sta.{h,c}         — STA join, retry, GOT_IP callback
//   bodylink_proto.{h,c}   — BodyLink JSON shapes (cJSON) — the protocol
//                            lives on; only its server socket was deleted
//   bodylink_motion.{h,c}  — capability profile, set_target, motion tick
//   station_link.{h,c}     — orbit-station WS client (commands in, state out)
//   station_ota.{h,c}      — OTA self-update over the station link
//
// Spec: ../../bodylink/DESIGN.md (shapes) + docs/SERVER-BRAIN-IMPL.md §5 (link)

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "servo.h"
#include "wifi_sta.h"
#include "bodylink_motion.h"
#include "station_link.h"

static const char *TAG = "main";

// 100 Hz motion tick — owned here since the WS-server layer that used to
// spawn it is gone. Pure local concern: advances transitions, writes servos.
static void motion_task(void *arg) {
    (void)arg;
    TickType_t next = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&next, pdMS_TO_TICKS(10));
        bl_motion_tick();
    }
}

static void on_got_ip(esp_ip4_addr_t ip) {
    (void)ip;
    station_link_start();   // the body's one socket: client → orbit-station
}

void app_main(void) {
    ESP_LOGI(TAG, "── dock_body_v0 (orbit-station body) ──");

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
#ifdef BL_SERVO_SWEEP
    // Opt-in wiring smoke test (-DBL_SERVO_SWEEP): move neck then foot through a
    // gentle range, holding each pose, so you can confirm a new board's servo
    // wiring before trusting the station path. Off in normal builds — flip the
    // flag on in platformio.ini (the C3 env) only during bring-up.
    servo_sweep_test();
#endif
    ESP_ERROR_CHECK(bl_motion_init());
    xTaskCreate(&motion_task, "bl_motion", 4096, NULL, 5, NULL);

#ifndef BL_DISABLE_WIFI
    ESP_ERROR_CHECK(wifi_sta_start(on_got_ip));
    if (wifi_sta_wait_connected(portMAX_DELAY)) {
        ESP_LOGI(TAG, "✅ Wi-Fi up; dialing orbit-station");
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
