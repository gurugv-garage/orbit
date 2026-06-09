// orbit-station client link. See station_link.h.
//
// Frame vocabulary is the STATION protocol (orbit-station/server/src/core/
// protocol.ts), NOT the BodyLink envelope:
//   → hello     { t:"hello", role:"firmware", id, dock, bodyAddr, label }
//   → subscribe { t:"subscribe", topics:["bodylink","config"] }
//   → publish   { t:"publish", topic:"bodylink", kind:"profile"|"state"|"heartbeat", payload }
//   ← event     { t:"event", topic:"bodylink", kind:"command", payload:{parts} }
//
// The station's `command` payload is exactly a BodyLink set_target *body*
// ({parts:{...}}), so we hand it straight to bl_motion_set_target — same motion
// path as a phone command.

#include "station_link.h"

#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"

#include "secrets.h"
#include "bodylink_motion.h"
#include "bodylink_ws.h"   // bl_ws_has_client()
#include "bodylink_proto.h"   // bl_build_part / bl_build_param_spec / BL_DEVICE_* / BL_WS_PORT

static const char *TAG = "station";

#ifndef STATION_URL
#define STATION_URL ""
#endif
#ifndef DOCK_NAME
#define DOCK_NAME "dock"
#endif

#define HEARTBEAT_MS   10000   // 10 s, per the console's last-seen display
#define STATE_MS        2000   // report body state every 2 s

static esp_websocket_client_handle_t s_client = NULL;
static char  s_body_addr[32] = "";   // "<ip>:17317"
static bool  s_profile_sent = false;

// ── frame builders ───────────────────────────────────────────────────────

// Build the same capability `parts` object the phone-facing server advertises,
// from the shared g_bl_parts table (decoupled copy — no dependency on ws.c).
static cJSON *build_profile_parts(void) {
    cJSON *parts = cJSON_CreateObject();
    for (int i = 0; i < g_bl_n_parts; ++i) {
        const bl_part_decl_t *p = &g_bl_parts[i];
        cJSON *params = cJSON_CreateObject();
        for (int j = 0; j < p->n_params; ++j) {
            const bl_param_spec_t *ps = &p->params[j];
            cJSON_AddItemToObject(params, ps->name,
                bl_build_param_spec(ps->type, ps->unit, ps->range_lo,
                                    ps->range_hi, ps->def, ps->description));
        }
        cJSON_AddItemToObject(parts, p->name,
            bl_build_part(p->description, p->home_pulse_us, params));
    }
    return parts;
}

// Send a `publish` frame: { t:"publish", topic, kind, payload }. Takes
// ownership of `payload` (deletes it). No-op if not connected.
static void publish(const char *topic, const char *kind, cJSON *payload) {
    if (!s_client || !esp_websocket_client_is_connected(s_client)) {
        if (payload) cJSON_Delete(payload);
        return;
    }
    cJSON *f = cJSON_CreateObject();
    cJSON_AddStringToObject(f, "t", "publish");
    cJSON_AddStringToObject(f, "topic", topic);
    cJSON_AddStringToObject(f, "kind", kind);
    cJSON_AddItemToObject(f, "payload", payload ? payload : cJSON_CreateObject());
    char *s = cJSON_PrintUnformatted(f);
    cJSON_Delete(f);
    if (s) {
        esp_websocket_client_send_text(s_client, s, strlen(s), portMAX_DELAY);
        free(s);
    }
}

static void send_hello(void) {
    cJSON *f = cJSON_CreateObject();
    cJSON_AddStringToObject(f, "t", "hello");
    cJSON_AddStringToObject(f, "role", "firmware");
    cJSON_AddStringToObject(f, "id", BL_DEVICE_ID);
    cJSON_AddStringToObject(f, "dock", DOCK_NAME);
    cJSON_AddStringToObject(f, "bodyAddr", s_body_addr);
    cJSON_AddStringToObject(f, "label", BL_DEVICE_NAME);
    char *s = cJSON_PrintUnformatted(f);
    cJSON_Delete(f);
    if (s) { esp_websocket_client_send_text(s_client, s, strlen(s), portMAX_DELAY); free(s); }

    // subscribe to console commands + config pushes
    const char *sub = "{\"t\":\"subscribe\",\"topics\":[\"bodylink\",\"config\"]}";
    esp_websocket_client_send_text(s_client, sub, strlen(sub), portMAX_DELAY);
}

// payload = profile body { body:{ device_id, name, fw_version, parts } }
static cJSON *build_profile_payload(void) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "device_id", BL_DEVICE_ID);
    cJSON_AddStringToObject(body, "name", BL_DEVICE_NAME);
    cJSON_AddStringToObject(body, "fw_version", BL_FW_VERSION);
    cJSON_AddItemToObject(body, "parts", build_profile_parts());
    cJSON *p = cJSON_CreateObject();
    cJSON_AddItemToObject(p, "body", body);
    return p;
}

// payload = { <part>: { pulse_width_us: <cur> }, ... }
static cJSON *build_state_payload(void) {
    cJSON *st = cJSON_CreateObject();
    for (int i = 0; i < g_bl_n_parts; ++i) {
        int us = bl_motion_current_us(i);
        if (us < 0) continue;
        cJSON *part = cJSON_CreateObject();
        cJSON_AddNumberToObject(part, "pulse_width_us", us);
        cJSON_AddItemToObject(st, g_bl_parts[i].name, part);
    }
    return st;
}

// ── inbound: station console `command` (a set_target body) ─────────────────

static void handle_event(cJSON *f) {
    const cJSON *topic = cJSON_GetObjectItemCaseSensitive(f, "topic");
    const cJSON *kind  = cJSON_GetObjectItemCaseSensitive(f, "kind");
    if (!cJSON_IsString(topic) || !cJSON_IsString(kind)) return;
    if (strcmp(topic->valuestring, "bodylink") != 0) return;
    if (strcmp(kind->valuestring, "command") != 0) return;

    cJSON *payload = cJSON_GetObjectItemCaseSensitive(f, "payload");
    if (!payload) return;
    // payload == set_target body ({parts:{...}}) → same motion path as the phone.
    bl_emit_t emits[8];
    int changed = 0;
    int n = bl_motion_set_target(payload, emits, 8, &changed);
    (void)n;
    ESP_LOGI(TAG, "console command applied (changed=%d)", changed);
    // reflect the new commanded state back promptly
    publish("bodylink", "state", build_state_payload());
}

static void on_ws_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)base;
    esp_websocket_event_data_t *ev = (esp_websocket_event_data_t *)data;
    switch (id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "connected to station %s", STATION_URL);
            s_profile_sent = false;
            send_hello();
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "station disconnected — will retry (body unaffected)");
            s_profile_sent = false;
            break;
        case WEBSOCKET_EVENT_DATA: {
            if (ev->op_code != 0x1 /* text */ || ev->data_len <= 0) break;
            cJSON *f = cJSON_ParseWithLength(ev->data_ptr, ev->data_len);
            if (!f) break;
            const cJSON *t = cJSON_GetObjectItemCaseSensitive(f, "t");
            if (cJSON_IsString(t)) {
                if (strcmp(t->valuestring, "welcome") == 0 && !s_profile_sent) {
                    publish("bodylink", "profile", build_profile_payload());
                    s_profile_sent = true;
                } else if (strcmp(t->valuestring, "event") == 0) {
                    handle_event(f);
                }
            }
            cJSON_Delete(f);
            break;
        }
        default: break;
    }
}

// ── periodic state + heartbeat task ────────────────────────────────────────

static void station_task(void *arg) {
    (void)arg;
    int64_t last_hb = 0;
    for (;;) {
        if (s_client && esp_websocket_client_is_connected(s_client) && s_profile_sent) {
            publish("bodylink", "state", build_state_payload());
            int64_t now = esp_timer_get_time() / 1000;
            if (now - last_hb >= HEARTBEAT_MS) {
                last_hb = now;
                cJSON *hb = cJSON_CreateObject();
                cJSON_AddNumberToObject(hb, "ts", (double)now);
                // report our own links so the station knows the mesh: is a
                // phone/brain currently driving us over the :17317 BodyLink server?
                cJSON *links = cJSON_CreateObject();
                cJSON_AddBoolToObject(links, "phoneClient", bl_ws_has_client());
                cJSON_AddItemToObject(hb, "links", links);
                publish("bodylink", "heartbeat", hb);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(STATE_MS));
    }
}

// ── public ──────────────────────────────────────────────────────────────

esp_err_t station_link_start(esp_ip4_addr_t our_ip) {
    if (STATION_URL[0] == '\0') {
        ESP_LOGI(TAG, "STATION_URL empty — station client disabled (body standalone)");
        return ESP_OK;
    }
    snprintf(s_body_addr, sizeof(s_body_addr), IPSTR ":%d", IP2STR(&our_ip), BL_WS_PORT);

    esp_websocket_client_config_t cfg = {
        .uri = STATION_URL,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 8000,
        // Keep auto-reconnect ON (default) and make a silently-dead link get
        // NOTICED so it actually re-dials. Without keepalive pings, a dropped
        // connection (station restart, WiFi blip) can leave the client stuck
        // "connected" in name only — never reconnecting until a manual reset.
        .disable_auto_reconnect = false,
        // WS-level keepalive: ping every 10s; if no pong in 3 tries, tear the
        // socket down → triggers reconnect.
        .ping_interval_sec = 10,
        .pingpong_timeout_sec = 20,
        // TCP-level keepalive as a second line of defence against half-open
        // sockets the OS would otherwise keep forever.
        .keep_alive_enable = true,
        .keep_alive_idle = 6,
        .keep_alive_interval = 3,
        .keep_alive_count = 3,
    };
    s_client = esp_websocket_client_init(&cfg);
    if (!s_client) {
        ESP_LOGE(TAG, "ws client init failed — body continues standalone");
        return ESP_FAIL;
    }
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    esp_websocket_client_start(s_client);   // async; retries on its own

    xTaskCreate(station_task, "station_task", 4096, NULL, 4, NULL);
    ESP_LOGI(TAG, "station client started → %s (dock=%s, body=%s)",
             STATION_URL, DOCK_NAME, s_body_addr);
    return ESP_OK;
}
