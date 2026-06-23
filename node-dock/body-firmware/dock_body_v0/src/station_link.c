// orbit-station client link. See station_link.h.
//
// Frame vocabulary is the STATION protocol (orbit-station/server/src/core/
// protocol.ts), NOT the BodyLink envelope:
//   → hello     { t:"hello", role:"device", id, dock, component:"body",
//                 kind:"dock-body-fw", caps:["servo"], label, build }
//   → subscribe { t:"subscribe", topics:["bodylink","config","ota","station"] }
//   → publish   { t:"publish", topic:"bodylink",
//                 kind:"profile"|"state"|"applied"|"event"|"heartbeat", payload }
//   ← event     { t:"event", topic:"bodylink", kind:"command", payload:{parts} }
//
// The station's `command` payload is exactly a BodyLink set_target *body*
// ({parts:{...}}) — the motion executor (modules/bodylink/motion.ts) is the
// single master; we hand it straight to bl_motion_set_target.

#include "station_link.h"

#include <string.h>
#include "esp_log.h"
#include "esp_system.h"   // esp_restart (reboot on dock move)
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_mac.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"

#include "secrets.h"
#include "bodylink_motion.h"
#include "bodylink_proto.h"   // bl_build_part / bl_build_param_spec / BL_DEVICE_*
#include "station_ota.h"   // station_ota_begin / station_ota_on_link_ready
#include "version.h"       // BL_FW_VERSION / BL_FW_BUILD

static const char *TAG = "station";

#ifndef STATION_URL
#define STATION_URL ""
#endif
#ifndef DOCK_NAME
#define DOCK_NAME "dock"
#endif

#define HEARTBEAT_MS   10000   // 10 s, per the console's last-seen display
#define STATE_MS        2000   // report body state every 2 s

// Staleness tripwire (DESIGN.md §5.1, applied to the station socket): the
// motion executor heartbeats targets at >= 1 Hz once it's driving us, so 30 s
// of command silence WHILE CONNECTED means the executor is broken — not a
// control path, a tripwire. We emit one `event:"stale"` and HOLD pose (never
// auto-home; the brain commands home explicitly when it wants it).
#define STALE_MS       30000

static esp_websocket_client_handle_t s_client = NULL;
static bool    s_profile_sent = false;
// hello-v2 `id` = the hardware instance: MAC-derived, never name-derived
// (two boards must never share an id). Filled at start; BL_DEVICE_ID is the
// fallback if the MAC read fails. The FULL 6-byte MAC ("body-aabbccddeeff") is
// the station's deviceId→dock binding key (docs/decision-traces/runtime-dock-binding.md).
static char    s_device_id[24] = BL_DEVICE_ID;
// Runtime dock binding: the dock this board belongs to. No longer compiled in —
// learned from the station's welcome frame and persisted to NVS so it survives
// reflash (NVS is a separate partition, not erased by app OTA). Empty = UNCLAIMED.
static char    s_dock[48] = "";
static int64_t s_last_cmd_ms  = 0;     // 0 = no command yet (tripwire unarmed)
static bool    s_stale_latched = false;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

// ── runtime dock binding: NVS-persisted dock name ──────────────────────────
// docs/decision-traces/runtime-dock-binding.md. The station owns the
// deviceId→dock binding; we cache the learned name in NVS so we re-announce it
// instantly on the next boot (and it survives an app-partition reflash).
#define DOCK_NVS_NS  "orbit"
#define DOCK_NVS_KEY "dock"

static void dock_load_from_nvs(void) {
    nvs_handle_t h;
    if (nvs_open(DOCK_NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    size_t len = sizeof(s_dock);
    if (nvs_get_str(h, DOCK_NVS_KEY, s_dock, &len) != ESP_OK) s_dock[0] = '\0';
    nvs_close(h);
}

static void dock_save_to_nvs(const char *dock) {
    nvs_handle_t h;
    if (nvs_open(DOCK_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, DOCK_NVS_KEY, dock);
    nvs_commit(h);
    nvs_close(h);
}

// Adopt a dock name learned from the station's welcome frame (a CLAIM): persist
// to NVS, then REBOOT for a clean reset. One code path — a fresh boot is the only
// fail-proof way to guarantee no stale in-memory state (motion targets,
// subscriptions, latches) carries into the new dock
// (docs/decision-traces/runtime-dock-binding.md). On reboot dock_load_from_nvs
// reads the new name and we re-announce; the welcome that echoes it then matches
// s_dock (strcmp == 0) so we DON'T reboot again — no loop.
static void dock_adopt(const char *dock) {
    if (!dock || dock[0] == '\0' || strcmp(dock, s_dock) == 0) return;
    snprintf(s_dock, sizeof(s_dock), "%s", dock);
    dock_save_to_nvs(s_dock);   // synchronous nvs_commit — on disk before reboot
    ESP_LOGW(TAG, "claimed dock '%s' — rebooting for a clean reset", s_dock);
    esp_restart();
}

// ── frame builders ───────────────────────────────────────────────────────

// Build the same capability `parts` object BodyLink's profile advertises,
// from the shared g_bl_parts table.
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

// Public wrapper for other modules (station_ota) to publish on the link.
void station_link_publish(const char *topic, const char *kind, cJSON *payload) {
    publish(topic, kind, payload);
}

bool station_link_ready(void) {
    return s_client && esp_websocket_client_is_connected(s_client) && s_profile_sent;
}

static void send_hello(void) {
    // hello v2 (protocol.ts): this peer = the `body` slot of its dock, running
    // software kind `dock-body-fw` (the OTA target), serving capability
    // `servo` (the motion executor routes by cap, never by component name).
    cJSON *f = cJSON_CreateObject();
    cJSON_AddStringToObject(f, "t", "hello");
    cJSON_AddStringToObject(f, "role", "device");
    cJSON_AddStringToObject(f, "id", s_device_id);
    // Runtime dock binding: send dock/component only when we KNOW our dock
    // (cached in NVS or a dev override). Unclaimed → omit; the station resolves
    // it from its binding and tells us via welcome. (docs/decision-traces/runtime-dock-binding.md)
    if (s_dock[0] != '\0') {
        cJSON_AddStringToObject(f, "dock", s_dock);
        cJSON_AddStringToObject(f, "component", "body");
    }
    cJSON_AddStringToObject(f, "kind", "dock-body-fw");
    cJSON *caps = cJSON_CreateArray();
    cJSON_AddItemToArray(caps, cJSON_CreateString("servo"));
    cJSON_AddItemToObject(f, "caps", caps);
    cJSON_AddStringToObject(f, "label", BL_DEVICE_NAME);
    // OTA gate (docs/OTA.md §3): `build` is the monotonic version. It's the
    // ONLY version on the wire — the station maps build→label as metadata.
    cJSON_AddNumberToObject(f, "build", BL_FW_BUILD);
    char *s = cJSON_PrintUnformatted(f);
    cJSON_Delete(f);
    if (s) { esp_websocket_client_send_text(s_client, s, strlen(s), portMAX_DELAY); free(s); }

    // commands + config pushes + OTA offers + sibling presence
    const char *sub = "{\"t\":\"subscribe\",\"topics\":[\"bodylink\",\"config\",\"ota\",\"station\"]}";
    esp_websocket_client_send_text(s_client, sub, strlen(sub), portMAX_DELAY);
}

// payload = profile body { body:{ device_id, name, fw_version, parts } }
static cJSON *build_profile_payload(void) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "device_id", s_device_id);
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

// Publish one motion emit (clamp/unknown) as a bodylink `event` so the
// console can see what the body rejected/clipped. (The executor pre-clamps,
// so these only fire on executor/profile drift — diagnostics, not flow.)
static void publish_emit_events(const bl_emit_t *emits, int n) {
    for (int i = 0; i < n; ++i) {
        const bl_emit_t *e = &emits[i];
        if (e->kind == BL_EMIT_NONE) continue;
        cJSON *p = cJSON_CreateObject();
        cJSON_AddStringToObject(p, "event",
            e->kind == BL_EMIT_OUT_OF_RANGE ? "clipped" :
            e->kind == BL_EMIT_UNKNOWN_PART ? "unknown_part" : "unknown_param");
        if (e->part[0])  cJSON_AddStringToObject(p, "part", e->part);
        if (e->param[0]) cJSON_AddStringToObject(p, "param", e->param);
        if (e->kind == BL_EMIT_OUT_OF_RANGE) {
            cJSON_AddNumberToObject(p, "requested", e->requested);
            cJSON_AddNumberToObject(p, "applied", e->applied);
        }
        publish("bodylink", "event", p);
    }
}

// ── inbound: station frames ─────────────────────────────────────────────

static void handle_event(cJSON *f) {
    const cJSON *topic = cJSON_GetObjectItemCaseSensitive(f, "topic");
    const cJSON *kind  = cJSON_GetObjectItemCaseSensitive(f, "kind");
    if (!cJSON_IsString(topic) || !cJSON_IsString(kind)) return;
    cJSON *payload = cJSON_GetObjectItemCaseSensitive(f, "payload");

    // ── ota/available: the station is offering us a newer firmware ────────
    // payload = { target:"body", build, version, url, sha256, size }. Hand it
    // to station_ota, which runs esp_https_ota on its OWN task — we must NOT
    // block this WS event callback (docs/OTA.md §4.2). station_ota guards
    // against re-entry and stale (non-newer build) offers itself.
    if (strcmp(topic->valuestring, "ota") == 0 &&
        strcmp(kind->valuestring, "available") == 0) {
        if (payload) station_ota_begin(payload);
        return;
    }

    // ── station/presence: sibling components of our dock (consume = log) ──
    if (strcmp(topic->valuestring, "station") == 0 &&
        strcmp(kind->valuestring, "presence") == 0) {
        char *s = payload ? cJSON_PrintUnformatted(payload) : NULL;
        ESP_LOGI(TAG, "dock presence: %s", s ? s : "{}");
        free(s);
        return;
    }

    if (strcmp(topic->valuestring, "bodylink") != 0) return;
    if (strcmp(kind->valuestring, "command") != 0) return;

    if (!payload) return;
    // payload == set_target body ({parts:{...}}) → the one motion path.
    bl_emit_t emits[8];
    int changed = 0;
    int n = bl_motion_set_target(payload, emits, 8, &changed);
    publish_emit_events(emits, n);

    // command stream is alive → reset the staleness tripwire
    s_last_cmd_ms = now_ms();
    if (s_stale_latched) {
        s_stale_latched = false;
        ESP_LOGI(TAG, "command stream resumed (stale latch cleared)");
    }

    // Per-message `applied` ack only when state actually changed (DESIGN.md
    // §3.2): heartbeat resends that no-op stay quiet on the wire.
    if (changed) {
        cJSON *ack = cJSON_CreateObject();
        cJSON *parts = cJSON_GetObjectItemCaseSensitive(payload, "parts");
        cJSON_AddItemToObject(ack, "parts",
            parts ? cJSON_Duplicate(parts, true) : cJSON_CreateObject());
        publish("bodylink", "applied", ack);
        ESP_LOGI(TAG, "command applied");
        // reflect the new commanded state back promptly
        publish("bodylink", "state", build_state_payload());
    }
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
            // Hold last commanded pose — do NOT auto-home (DESIGN.md §5.2:
            // homing surprises users; the brain homes explicitly).
            ESP_LOGW(TAG, "station disconnected — holding pose, will retry");
            s_profile_sent = false;
            s_last_cmd_ms = 0;          // disarm the tripwire while offline
            s_stale_latched = false;
            break;
        case WEBSOCKET_EVENT_DATA: {
            if (ev->op_code != 0x1 /* text */ || ev->data_len <= 0) break;
            cJSON *f = cJSON_ParseWithLength(ev->data_ptr, ev->data_len);
            if (!f) break;
            const cJSON *t = cJSON_GetObjectItemCaseSensitive(f, "t");
            if (cJSON_IsString(t)) {
                if (strcmp(t->valuestring, "welcome") == 0) {
                    // Runtime dock binding: the welcome carries our dock (resolved
                    // from the station's binding, or pushed when a console claim
                    // binds us). Adopt + persist it. A claim arrives as a SECOND
                    // welcome on the live socket — adopt it even after profile sent.
                    const cJSON *d = cJSON_GetObjectItemCaseSensitive(f, "dock");
                    if (cJSON_IsString(d)) dock_adopt(d->valuestring);
                }
                if (strcmp(t->valuestring, "welcome") == 0 && !s_profile_sent) {
                    publish("bodylink", "profile", build_profile_payload());
                    s_profile_sent = true;
                    // Link is now fully up (Wi-Fi + station + profile accepted).
                    // If we're a freshly-OTA'd image in pending-verify, this is
                    // the proof it works → cancel rollback (docs/OTA.md §4.3).
                    station_ota_on_link_ready();
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

// ── periodic state + heartbeat + staleness task ────────────────────────────

static void station_task(void *arg) {
    (void)arg;
    int64_t last_hb = 0;
    for (;;) {
        if (s_client && esp_websocket_client_is_connected(s_client) && s_profile_sent) {
            publish("bodylink", "state", build_state_payload());
            int64_t now = now_ms();
            if (now - last_hb >= HEARTBEAT_MS) {
                last_hb = now;
                cJSON *hb = cJSON_CreateObject();
                cJSON_AddNumberToObject(hb, "ts", (double)now);
                // OTA build in every heartbeat (docs/OTA.md §3) — keeps the
                // station's version view fresh + self-healing without waiting
                // for a full reconnect. Just the gate int; small payload.
                cJSON_AddNumberToObject(hb, "build", BL_FW_BUILD);
                publish("bodylink", "heartbeat", hb);
            }
            // Staleness tripwire: armed once the executor has driven us at
            // least once this connection; latched so it fires ONCE per stall.
            if (s_last_cmd_ms > 0 && !s_stale_latched &&
                now - s_last_cmd_ms > STALE_MS) {
                s_stale_latched = true;
                ESP_LOGW(TAG, "no command for %llds — executor stale? holding pose",
                         (long long)((now - s_last_cmd_ms) / 1000));
                cJSON *p = cJSON_CreateObject();
                cJSON_AddStringToObject(p, "event", "stale");
                cJSON_AddNumberToObject(p, "silent_ms", (double)(now - s_last_cmd_ms));
                publish("bodylink", "event", p);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(STATE_MS));
    }
}

// ── public ──────────────────────────────────────────────────────────────

esp_err_t station_link_start(void) {
    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        // FULL 6-byte MAC = the station's binding key (collision-safe across
        // boards). docs/decision-traces/runtime-dock-binding.md.
        snprintf(s_device_id, sizeof(s_device_id), "body-%02x%02x%02x%02x%02x%02x",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
    // Runtime dock binding: prefer the NVS-cached dock; else a compile-time
    // DOCK_NAME dev override (seed it into NVS so we self-bind). Empty ⇒ unclaimed.
    dock_load_from_nvs();
    if (s_dock[0] == '\0' && DOCK_NAME[0] != '\0') {
        snprintf(s_dock, sizeof(s_dock), "%s", DOCK_NAME);
        dock_save_to_nvs(s_dock);
    }
    ESP_LOGI(TAG, "station id=%s dock=%s", s_device_id, s_dock[0] ? s_dock : "(unclaimed)");
    if (STATION_URL[0] == '\0') {
        ESP_LOGI(TAG, "STATION_URL empty — station client disabled (servos hold center)");
        return ESP_OK;
    }

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
        ESP_LOGE(TAG, "ws client init failed — body holds pose, no station");
        return ESP_FAIL;
    }
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    esp_websocket_client_start(s_client);   // async; retries on its own

    xTaskCreate(station_task, "station_task", 4096, NULL, 4, NULL);
    ESP_LOGI(TAG, "station client started → %s (dock=%s, component=body)",
             STATION_URL, DOCK_NAME);
    return ESP_OK;
}
