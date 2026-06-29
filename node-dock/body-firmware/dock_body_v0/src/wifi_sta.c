// Wi-Fi STA implementation. See wifi_sta.h.

#include "wifi_sta.h"

#include <string.h>
#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/event_groups.h"

#include "secrets.h"

static const char *TAG = "wifi_sta";

#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1

// 20 retries × ~2s each = ~40s before giving up. Auto-retry continues
// after the budget is hit if you call wifi_sta_start() again — but in
// practice we never do; if Wi-Fi can't come up, the dock body parks at
// its home pose and waits for power-cycle.
static const int kMaxRetries = 20;

static EventGroupHandle_t s_eg;
static int s_retry_count = 0;
static wifi_sta_on_got_ip_t s_on_got_ip = NULL;

static const char *reason_str(int reason) {
    switch (reason) {
        case WIFI_REASON_AUTH_EXPIRE:             return "AUTH_EXPIRE (2)";
        case WIFI_REASON_AUTH_LEAVE:              return "AUTH_LEAVE (3)";
        case WIFI_REASON_ASSOC_EXPIRE:            return "ASSOC_EXPIRE (4)";
        case WIFI_REASON_ASSOC_TOOMANY:           return "ASSOC_TOOMANY (5)";
        case WIFI_REASON_NOT_AUTHED:              return "NOT_AUTHED (6)";
        case WIFI_REASON_NOT_ASSOCED:             return "NOT_ASSOCED (7)";
        case WIFI_REASON_ASSOC_LEAVE:             return "ASSOC_LEAVE (8)";
        case WIFI_REASON_ASSOC_NOT_AUTHED:        return "ASSOC_NOT_AUTHED (9)";
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:  return "4WAY_HANDSHAKE_TIMEOUT (15)";
        case WIFI_REASON_GROUP_KEY_UPDATE_TIMEOUT:return "GROUP_KEY_UPDATE_TIMEOUT (16)";
        case WIFI_REASON_AKMP_INVALID:            return "AKMP_INVALID (20)";
        case WIFI_REASON_BEACON_TIMEOUT:          return "BEACON_TIMEOUT (200)";
        case WIFI_REASON_NO_AP_FOUND:             return "NO_AP_FOUND (201)";
        case WIFI_REASON_AUTH_FAIL:               return "AUTH_FAIL (202)";
        case WIFI_REASON_ASSOC_FAIL:              return "ASSOC_FAIL (203)";
        case WIFI_REASON_HANDSHAKE_TIMEOUT:       return "HANDSHAKE_TIMEOUT (204)";
        case WIFI_REASON_CONNECTION_FAIL:         return "CONNECTION_FAIL (205)";
        default:                                  return "OTHER";
    }
}

static void event_handler(void *arg, esp_event_base_t base,
                          int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "STA started — issuing connect()");
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        wifi_event_sta_connected_t *e = (wifi_event_sta_connected_t *)data;
        ESP_LOGI(TAG, "STA associated to '%.*s' on channel %u (auth=%d)",
                 e->ssid_len, (const char *)e->ssid, e->channel, e->authmode);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "STA disconnected — reason=%d %s (rssi=%d)",
                 e->reason, reason_str(e->reason), e->rssi);
        if (s_retry_count < kMaxRetries) {
            s_retry_count++;
            ESP_LOGI(TAG, "Retrying connect (%d/%d) ...", s_retry_count, kMaxRetries);
            esp_wifi_connect();
        } else {
            ESP_LOGE(TAG, "Gave up after %d retries", kMaxRetries);
            xEventGroupSetBits(s_eg, WIFI_FAIL_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Got IP: " IPSTR " (gateway " IPSTR ", netmask " IPSTR ")",
                 IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw),
                 IP2STR(&e->ip_info.netmask));
        s_retry_count = 0;
        if (s_on_got_ip) s_on_got_ip(e->ip_info.ip);
        xEventGroupSetBits(s_eg, WIFI_CONNECTED_BIT);
    }
}

esp_err_t wifi_sta_start(wifi_sta_on_got_ip_t on_got_ip) {
    s_on_got_ip = on_got_ip;
    s_eg = xEventGroupCreate();
    if (!s_eg) return ESP_ERR_NO_MEM;

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL, NULL));

    wifi_config_t wcfg = {
        .sta = {
            // PMF capable, not required — the magic vs arduino-esp32.
            .pmf_cfg   = { .capable = true, .required = false },
            .threshold = { .authmode = WIFI_AUTH_WPA2_PSK },
        },
    };
    strncpy((char *)wcfg.sta.ssid,     WIFI_SSID,     sizeof(wcfg.sta.ssid));
    strncpy((char *)wcfg.sta.password, WIFI_PASSWORD, sizeof(wcfg.sta.password));
    ESP_LOGI(TAG, "Wi-Fi config: ssid='%s' (pmf_capable=1, auth_min=WPA2-PSK)",
             WIFI_SSID);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wcfg));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_start());

#if CONFIG_IDF_TARGET_ESP32C3
    // ESP32-C3 only: cap TX power well below the 20 dBm default. On the C3 — and
    // especially a trace-antenna "mini" with light power decoupling — a full-power
    // TX burst spikes current enough to sag the 3V3 rail mid-frame, corrupting the
    // WPA 4-way handshake. The symptom is exactly what we saw: strong RSSI but the
    // association never completes (AUTH_EXPIRE / ASSOC_EXPIRE / 4WAY_HANDSHAKE_
    // TIMEOUT / AUTH_FAIL at -52 dBm on a freshly-rebooted AP). Dropping to ~8.5 dBm
    // is the widely-reported fix (ESPHome output_power: 8.5; arduino-esp32 #6767,
    // esphome/issues #4893). Unit is 0.25 dBm steps → 34 = 8.5 dBm. The S3 (separate
    // USB + better decoupling) doesn't need this and keeps full power.
    {
        esp_err_t pr = esp_wifi_set_max_tx_power(34);   // 34 * 0.25 = 8.5 dBm
        ESP_LOGI(TAG, "C3 TX power capped to 8.5 dBm (set_max_tx_power=34): %s",
                 esp_err_to_name(pr));
    }
#endif

    ESP_LOGI(TAG, "wifi_init done — waiting for events ...");
    return ESP_OK;
}

bool wifi_sta_wait_connected(TickType_t ticks_to_wait) {
    EventBits_t bits = xEventGroupWaitBits(
        s_eg, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, pdFALSE, ticks_to_wait);
    return (bits & WIFI_CONNECTED_BIT) != 0;
}
