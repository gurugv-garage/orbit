// BodyLink WebSocket layer. See bodylink_ws.h.
//
// Threading:
//   - httpd's own task runs `ws_handler` per incoming frame.
//   - We spawn a `bl_motion_task` (FreeRTOS, ~100 Hz) for the motion tick.
//     It mutates servo µs via bl_motion_tick(); the mutex lives inside
//     bl_motion. No WS sending from this task.
//   - Single-client state (`s_client_fd`, `s_handshake_done`) is guarded
//     by `s_client_mtx`.

#include "bodylink_ws.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>      // close()
#include <sys/socket.h>  // getpeername()
#include <netinet/in.h>
#include <arpa/inet.h>   // inet_ntop()
#include "esp_log.h"
#include "esp_http_server.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#include "bodylink_proto.h"
#include "bodylink_motion.h"

static const char *TAG = "bl_ws";

// ── State ──────────────────────────────────────────────────────────────

static httpd_handle_t s_httpd = NULL;
static int            s_client_fd = -1;
static bool           s_handshake_done = false;
static SemaphoreHandle_t s_client_mtx = NULL;
static TaskHandle_t   s_motion_task = NULL;

static int now_ms_short(void) {
    return (int)(esp_timer_get_time() / 1000);
}

// Send one text frame on a given req's socket. `json` is malloc'd by the
// proto layer; we free it here once sent.
static esp_err_t send_text(httpd_req_t *req, char *json) {
    if (!json) return ESP_ERR_NO_MEM;
    httpd_ws_frame_t out = {
        .final = true,
        .fragmented = false,
        .type = HTTPD_WS_TYPE_TEXT,
        .payload = (uint8_t *)json,
        .len = strlen(json),
    };
    esp_err_t r = httpd_ws_send_frame(req, &out);
    if (r != ESP_OK) {
        ESP_LOGW(TAG, "ws_send_frame failed: %s", esp_err_to_name(r));
    }
    free(json);
    return r;
}

// Emit one bl_emit_t as wire messages (error + optional event:clipped).
static void send_emits(httpd_req_t *req, const bl_emit_t *emits, int n) {
    char msg[160];
    for (int i = 0; i < n; ++i) {
        const bl_emit_t *e = &emits[i];
        switch (e->kind) {
            case BL_EMIT_UNKNOWN_PART:
                snprintf(msg, sizeof(msg), "unknown part: '%s'", e->part);
                send_text(req, bl_enc_error(now_ms_short(), "UNKNOWN_PART", msg, false));
                break;
            case BL_EMIT_UNKNOWN_PARAM:
                snprintf(msg, sizeof(msg), "part '%s' has no param '%s'", e->part, e->param);
                send_text(req, bl_enc_error(now_ms_short(), "UNKNOWN_PARAM", msg, false));
                break;
            case BL_EMIT_OUT_OF_RANGE:
                snprintf(msg, sizeof(msg), "%s.%s=%.0f clipped to %.0f",
                         e->part, e->param, e->requested, e->applied);
                send_text(req, bl_enc_error(now_ms_short(), "OUT_OF_RANGE", msg, false));
                send_text(req, bl_enc_event_clipped(now_ms_short(),
                                                     e->part, e->param,
                                                     e->requested, e->applied));
                break;
            default:
                break;
        }
    }
}

// Build the full `parts` object for the profile message from g_bl_parts.
static cJSON *build_profile_parts(void) {
    cJSON *parts = cJSON_CreateObject();
    for (int i = 0; i < g_bl_n_parts; ++i) {
        const bl_part_decl_t *p = &g_bl_parts[i];
        cJSON *params = cJSON_CreateObject();
        for (int j = 0; j < p->n_params; ++j) {
            const bl_param_spec_t *ps = &p->params[j];
            cJSON_AddItemToObject(params, ps->name,
                                  bl_build_param_spec(ps->type, ps->unit,
                                                      ps->range_lo, ps->range_hi,
                                                      ps->def, ps->description));
        }
        cJSON_AddItemToObject(parts, p->name,
                              bl_build_part(p->description, p->home_pulse_us, params));
    }
    return parts;
}

// ── WS handler ─────────────────────────────────────────────────────────

static esp_err_t ws_handler(httpd_req_t *req) {
    int fd = httpd_req_to_sockfd(req);

    if (req->method == HTTP_GET) {
        // WS upgrade handshake just completed.
        xSemaphoreTake(s_client_mtx, portMAX_DELAY);
        if (s_client_fd >= 0 && s_client_fd != fd) {
            // Already have a client — reject this one.
            xSemaphoreGive(s_client_mtx);
            ESP_LOGW(TAG, "WS connect rejected (fd=%d): another client active (fd=%d)",
                     fd, s_client_fd);
            send_text(req, bl_enc_error(now_ms_short(), "BUSY",
                                        "another Brain is already connected", true));
            httpd_sess_trigger_close(s_httpd, fd);
            return ESP_OK;
        }
        s_client_fd = fd;
        s_handshake_done = false;
        xSemaphoreGive(s_client_mtx);

        // Log the peer IP — handy for spotting which device owns the body link.
        struct sockaddr_in6 paddr;
        socklen_t paddr_len = sizeof(paddr);
        char peer_ip[40] = "?";
        if (getpeername(fd, (struct sockaddr *)&paddr, &paddr_len) == 0) {
            inet_ntop(AF_INET6, &paddr.sin6_addr, peer_ip, sizeof(peer_ip));
        }
        ESP_LOGI(TAG, "WS client connected (fd=%d) from %s", fd, peer_ip);
        // event:boot fires immediately, before hello.
        send_text(req, bl_enc_event_boot(now_ms_short()));
        return ESP_OK;
    }

    // Data frame. Two-call recv pattern: length first, then payload.
    httpd_ws_frame_t in = {0};
    in.type = HTTPD_WS_TYPE_TEXT;
    esp_err_t r = httpd_ws_recv_frame(req, &in, 0);
    if (r != ESP_OK) {
        ESP_LOGW(TAG, "ws_recv_frame (len query) failed: %s", esp_err_to_name(r));
        return r;
    }
    uint8_t *buf = NULL;
    if (in.len) {
        buf = calloc(1, in.len + 1);
        if (!buf) return ESP_ERR_NO_MEM;
        in.payload = buf;
        r = httpd_ws_recv_frame(req, &in, in.len);
        if (r != ESP_OK) {
            ESP_LOGW(TAG, "ws_recv_frame (payload) failed: %s", esp_err_to_name(r));
            free(buf);
            return r;
        }
    }
    ESP_LOGI(TAG, "WS recv (fd=%d, len=%u): %.*s",
             fd, (unsigned)in.len, (int)in.len, buf ? (const char *)buf : "");

    cJSON *env = bl_parse((const char *)(buf ? buf : (const uint8_t *)""), in.len);
    if (!env) {
        send_text(req, bl_enc_error(now_ms_short(), "BAD_MESSAGE",
                                    "malformed JSON", false));
        free(buf);
        return ESP_OK;
    }

    const char *mtype = bl_env_type(env);
    const char *mid   = bl_env_id(env);
    cJSON      *body  = bl_env_body(env);

    if (!s_handshake_done) {
        if (!mtype || strcmp(mtype, "hello") != 0) {
            send_text(req, bl_enc_error(now_ms_short(), "BAD_MESSAGE",
                                        "expected 'hello' first", true));
            httpd_sess_trigger_close(s_httpd, fd);
            goto done;
        }
        if (bl_env_v(env) != BL_PROTOCOL_VERSION || !bl_hello_offers_v0(body)) {
            send_text(req, bl_enc_error(now_ms_short(), "BAD_VERSION",
                                        "body speaks v0 only", true));
            httpd_sess_trigger_close(s_httpd, fd);
            goto done;
        }
        send_text(req, bl_enc_welcome(now_ms_short()));
        send_text(req, bl_enc_profile(now_ms_short(), build_profile_parts()));
        xSemaphoreTake(s_client_mtx, portMAX_DELAY);
        s_handshake_done = true;
        xSemaphoreGive(s_client_mtx);
        ESP_LOGI(TAG, "handshake complete (fd=%d)", fd);
        goto done;
    }

    if (!mtype) {
        send_text(req, bl_enc_error(now_ms_short(), "BAD_MESSAGE",
                                    "missing 'type'", false));
        goto done;
    }

    if (strcmp(mtype, "set_target") == 0) {
        bl_emit_t emits[16];
        int changed = 0;
        int n = bl_motion_set_target(body, emits, 16, &changed);
        send_emits(req, emits, n);
        // Per-message ack — only if state actually changed (DESIGN.md §3.2).
        // Heartbeat resends that no-op produce no ack, keeping wire quiet.
        if (changed) {
            send_text(req, bl_enc_applied(mid, now_ms_short(), "applied"));
        }

    } else if (strcmp(mtype, "echo") == 0) {
        int seq = 0;
        long long host_ts = 0;
        if (body) {
            cJSON *s = cJSON_GetObjectItemCaseSensitive(body, "seq");
            cJSON *h = cJSON_GetObjectItemCaseSensitive(body, "host_ts");
            if (cJSON_IsNumber(s)) seq = (int)s->valuedouble;
            if (cJSON_IsNumber(h)) host_ts = (long long)h->valuedouble;
        }
        send_text(req, bl_enc_echo_reply(mid, now_ms_short(), seq, host_ts, now_ms_short()));

    } else if (strcmp(mtype, "hello") == 0) {
        send_text(req, bl_enc_error(now_ms_short(), "BAD_MESSAGE",
                                    "duplicate hello", false));

    } else {
        char msg[64];
        snprintf(msg, sizeof(msg), "unknown message type: %s", mtype);
        send_text(req, bl_enc_error(now_ms_short(), "UNKNOWN_TYPE", msg, false));
    }

done:
    cJSON_Delete(env);
    free(buf);
    return ESP_OK;
}

// ── Disconnect detection ────────────────────────────────────────────────
//
// esp_http_server doesn't give us a "client closed" callback by default,
// but it has `httpd_config_t.close_fn` which we can override. When called
// for our active client's fd, we clear the singleton state so the next
// connect proceeds normally.

static void on_close(httpd_handle_t hd, int fd) {
    (void)hd;
    bool was_ours = false;
    xSemaphoreTake(s_client_mtx, portMAX_DELAY);
    if (s_client_fd == fd) {
        s_client_fd = -1;
        s_handshake_done = false;
        was_ours = true;
    }
    xSemaphoreGive(s_client_mtx);
    if (was_ours) {
        ESP_LOGI(TAG, "WS client disconnected (fd=%d)", fd);
    }
    // Default close behaviour: actually close the socket.
    close(fd);
}

// ── Motion task ────────────────────────────────────────────────────────

static void motion_task(void *arg) {
    (void)arg;
    TickType_t next = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&next, pdMS_TO_TICKS(10));  // 100 Hz
        bl_motion_tick();
    }
}

// ── Public API ─────────────────────────────────────────────────────────

bool bl_ws_has_client(void) {
    xSemaphoreTake(s_client_mtx, portMAX_DELAY);
    bool up = (s_client_fd >= 0) && s_handshake_done;
    xSemaphoreGive(s_client_mtx);
    return up;
}

esp_err_t bl_ws_start(void) {
    if (s_httpd) return ESP_OK;

    if (!s_client_mtx) {
        s_client_mtx = xSemaphoreCreateMutex();
        if (!s_client_mtx) return ESP_ERR_NO_MEM;
    }

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port  = BL_WS_PORT;
    cfg.ctrl_port    = BL_WS_PORT + 1000;
    cfg.stack_size   = 8192;       // cJSON + dispatch
    cfg.close_fn     = on_close;

    esp_err_t r = httpd_start(&s_httpd, &cfg);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(r));
        s_httpd = NULL;
        return r;
    }

    httpd_uri_t uri = {
        .uri          = "/",
        .method       = HTTP_GET,
        .handler      = ws_handler,
        .user_ctx     = NULL,
        .is_websocket = true,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_httpd, &uri));

    if (!s_motion_task) {
        xTaskCreate(&motion_task, "bl_motion", 4096, NULL, 5, &s_motion_task);
    }

    ESP_LOGI(TAG, "BodyLink WS listening on ws://<this-ip>:%d/", BL_WS_PORT);
    return ESP_OK;
}

esp_err_t bl_ws_stop(void) {
    if (s_httpd) {
        httpd_stop(s_httpd);
        s_httpd = NULL;
    }
    if (s_motion_task) {
        vTaskDelete(s_motion_task);
        s_motion_task = NULL;
    }
    return ESP_OK;
}
