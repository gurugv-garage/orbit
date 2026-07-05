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

// RSSI-low telemetry threshold (dBm). When the averaged RSSI drops below this,
// the driver posts WIFI_EVENT_STA_BSS_RSSI_LOW once; we log it and re-arm. This
// is DIAGNOSTIC only (it doesn't change the link) — it surfaces "signal went
// weak" proactively instead of us inferring it from loss bursts. −70 is the
// knee where this C3's trace antenna starts dropping under load (empirical).
#define WIFI_RSSI_LOW_DBM   (-70)

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
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_BSS_RSSI_LOW) {
        // Averaged RSSI crossed below WIFI_RSSI_LOW_DBM. Log it and RE-ARM — the
        // driver fires this only once per set_rssi_threshold() call, so without
        // re-arming we'd hear about the first dip and never again.
        wifi_event_bss_rssi_low_t *e = (wifi_event_bss_rssi_low_t *)data;
        ESP_LOGW(TAG, "RSSI LOW: avg rssi=%d dBm (< %d) — link entering the weak-signal "
                 "regime where drops/latency spike; not a firmware fault",
                 (int)e->rssi, WIFI_RSSI_LOW_DBM);
        esp_wifi_set_rssi_threshold(WIFI_RSSI_LOW_DBM);   // re-arm for the next crossing
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Got IP: " IPSTR " (gateway " IPSTR ", netmask " IPSTR ")",
                 IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw),
                 IP2STR(&e->ip_info.netmask));
        s_retry_count = 0;
        // Arm the RSSI-low telemetry now that we're associated (must be set while
        // connected; it's cleared on disconnect, so we re-set it on every GOT_IP).
        esp_wifi_set_rssi_threshold(WIFI_RSSI_LOW_DBM);
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

    // Beacon-loss tolerance. By default a STA that misses beacons for ~6s FORCE-
    // disconnects (WIFI_REASON_BEACON_TIMEOUT / ASSOC_EXPIRE). On this C3's weak
    // −74 dBm trace-antenna link, a brief beacon gap during a fade trips that and
    // tears down the WS — the "goes offline then reconnects" flapping we chased.
    // Raise the inactive-time window so the STA RIDES OUT short dropouts instead
    // of deauthing. This makes the link more FORGIVING of weak signal; it does
    // NOT make the signal stronger (packet loss / latency at −74 are physics —
    // the real fix is position / antenna / the S3 body). Range is [3,60]s.
    esp_err_t it = esp_wifi_set_inactive_time(WIFI_IF_STA, 20);
    ESP_LOGI(TAG, "beacon inactive-time set to 20s (was ~6s default): %s",
             esp_err_to_name(it));

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
    //
    // RANGE-vs-SAG SWEEP (in progress): 8.5 dBm survives the rail sag but can't
    // reach ~5 m (50-100% packet loss observed). Walking the cap UP to buy range,
    // testing the WPA handshake at CLOSE range (worst-case sag) after each step. If
    // the handshake starts failing again, we've hit the bare rail's ceiling — that's
    // where a 3V3 bulk cap comes in to push it higher. Step ladder (·0.25 dBm):
    //   34 = 8.5 dBm (rail-safe baseline)   44 = 11 dBm   48 = 12 dBm (SETTLED)
    //   56 = 14 dBm                         60 = 15 dBm
    //   78 = ~19.5 dBm (near default; needs the cap)
    // 2026-07 SWEEP RESULT: with 2× 100 µF caps, walked TX 15→14→12→11 and
    // burst-tested each at ~−60 dBm. 12 dBm (q48) was drop-free (8/8 clean);
    // 11 dBm (q44) showed a reproducible ~1-in-10 total-loss blip; 15 dBm gave
    // no benefit. KEY FINDING: link reliability tracks RSSI, not TX rung — at
    // −74 dBm EVERY rung collapses (5/12 total drops, ~900 ms RTT). So 12 dBm is
    // the settled floor (lowest rail-safe TX that still holds range); the real
    // reliability lever is signal / antenna / distance (or the S3 body).
    // 2026-07 PLACEMENT A/B (same distance, USB power, C3-only, unchanged TX/caps):
    // walked one spot → another at the SAME "far" range and back. Old spot: −70/−74
    // dBm, RTT 250-880 ms, loss 0→100 % blips (broken). Different spot, same distance:
    // −66 dBm, 0 % loss, ~20 ms RTT (clean) — and rejoined clean across several
    // reboots. Moving BACK reproduced the break exactly. CONFIRMS the KEY FINDING with
    // a controlled A/B: at range, RSSI is dominated by PATH/obstruction, not distance,
    // and placement alone swings it ±8-10 dB across the −74 collapse knee. Power/cap
    // changes do NOT help a weak-RSSI spot (packets arrive but slow — receive-limited);
    // the fix is position / orientation / a closer AP / the S3 body.
    // 2026-07 ENCLOSURE/RF A/B (same far spot, own USB, other equipment OFF+disconnected):
    // bare C3 = −66 dBm / 0 % / 20 ms (clean). Mounted on the BREADBOARD amid the rig
    // (antenna reoriented to fit) = −77 to −85 dBm, 100 % loss, could not hold an
    // association — a ~15-20 dB antenna hit purely from the board mass/jumpers/nearby
    // equipment detuning+shadowing the C3 trace antenna. Removing it from the breadboard
    // recovered ~10 dB immediately (−70/−75, re-associated). Power was RULED OUT (own USB,
    // equipment off AND unplugged — still dead on the breadboard), so this is RF, not rail:
    // no cap and no software knob recovers it. CONFIG IS EXHAUSTED for weak signal — TX is
    // already at the rail-safe max (12 dBm; 15 gave nothing), beacon inactive-time is
    // stretched to 20 s, PS is NONE. Remaining levers are all PHYSICAL: antenna orientation
    // (edge facing AP, clear air), distance/position, a closer AP, a u.FL/IPEX external
    // antenna (the XIAO C3 exposes the connector — the one cheap real-gain upgrade for THIS
    // board), or the S3 body. Keep the antenna edge clear of the board/jumpers/metal.
    // 2026-07 CROSS-BOARD RSSI IS NOT COMPARABLE (C3 vs S3): observed a NEARER S3
    // reporting a LOWER rssi (−65) than a FARTHER C3 (−58) — looks backwards, isn't.
    // The app WiFi/net code is one shared path (this file); the ONLY chip #if is the
    // C3 TX cap below. But the RADIOS differ: C3 runs 12 dBm + FULL RF cal every boot
    // (CONFIG_ESP_PHY_RF_CAL_FULL, sdkconfig.defaults.esp32c3), S3 runs full ~20 dBm +
    // default (partial) cal — different silicon, front-end, antenna, AND calibration
    // baseline. So rssi is a PER-RADIO ruler: only ever compare a board to ITSELF over
    // time (e.g. the C3's own −85→−58). To compare two DIFFERENT boards, use the active
    // loss/RTT probe, not rssi — by that metric the near S3 (0 %, ~18 ms) beat the C3
    // (0 %, ~27 ms) even while its rssi number read "worse."
    // 2026-07 S3 HOLDS RANGE where the C3 collapses (the counterpart to the C3 data
    // above): the S3, moved to the FAR spots that broke the C3 (−74/−85, 800 ms,
    // flapping), stayed −62/−65 dBm, 0 % loss, ~20-25 ms RTT, reconnects=1 — got
    // slightly BETTER when moved farther (path, not distance). Confirms the standing
    // conclusion: for far placement use the S3 (full 20 dBm + better front-end/antenna),
    // not the C3. NB heat is NOT a factor in any of this — every failure was RF/rssi/
    // antenna (receive-side), heap stayed stable, no thermal resets/throttle; a heatsink
    // does nothing for connection reliability (it'd only matter for long servo-duty heat).
    #define BL_C3_TX_POWER_Q 48   // 48 * 0.25 = 12 dBm  (settled — see sweep above)
    {
        esp_err_t pr = esp_wifi_set_max_tx_power(BL_C3_TX_POWER_Q);
        ESP_LOGI(TAG, "C3 TX power set to %.2f dBm (set_max_tx_power=%d): %s",
                 BL_C3_TX_POWER_Q * 0.25, BL_C3_TX_POWER_Q, esp_err_to_name(pr));
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
