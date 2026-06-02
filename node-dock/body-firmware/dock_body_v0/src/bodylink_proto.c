// BodyLink wire encode/decode — implementation. See bodylink_proto.h.

#include "bodylink_proto.h"

#include <math.h>
#include <string.h>

// Helper: build envelope { v, type, ts, body }. Adds `body` as-owned-by-env,
// stringifies, then deletes env. Returns malloc'd string.
static char *envelope(const char *type, int ts, cJSON *body) {
    cJSON *env = cJSON_CreateObject();
    cJSON_AddNumberToObject(env, "v", BL_PROTOCOL_VERSION);
    cJSON_AddStringToObject(env, "type", type);
    cJSON_AddNumberToObject(env, "ts", (double)ts);
    cJSON_AddItemToObject(env, "body", body ? body : cJSON_CreateObject());
    char *out = cJSON_PrintUnformatted(env);
    cJSON_Delete(env);
    return out;
}

static char *envelope_with_id(const char *type, const char *id, int ts, cJSON *body) {
    cJSON *env = cJSON_CreateObject();
    cJSON_AddNumberToObject(env, "v", BL_PROTOCOL_VERSION);
    cJSON_AddStringToObject(env, "type", type);
    if (id) cJSON_AddStringToObject(env, "id", id);
    cJSON_AddNumberToObject(env, "ts", (double)ts);
    cJSON_AddItemToObject(env, "body", body ? body : cJSON_CreateObject());
    char *out = cJSON_PrintUnformatted(env);
    cJSON_Delete(env);
    return out;
}

char *bl_enc_event_boot(int ts) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "kind", "boot");
    return envelope("event", ts, body);
}

char *bl_enc_event_clipped(int ts, const char *part, const char *param,
                           double requested, double applied) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "kind", "clipped");
    cJSON_AddStringToObject(body, "part", part);
    cJSON_AddStringToObject(body, "param", param);
    cJSON_AddNumberToObject(body, "requested", requested);
    cJSON_AddNumberToObject(body, "applied", applied);
    return envelope("event", ts, body);
}

char *bl_enc_welcome(int ts) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "device_id",  BL_DEVICE_ID);
    cJSON_AddStringToObject(body, "name",       BL_DEVICE_NAME);
    cJSON_AddStringToObject(body, "fw_version", BL_FW_VERSION);
    cJSON_AddNumberToObject(body, "proto",      BL_PROTOCOL_VERSION);
    return envelope("welcome", ts, body);
}

char *bl_enc_profile(int ts, cJSON *parts_json) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "device_id",  BL_DEVICE_ID);
    cJSON_AddStringToObject(body, "name",       BL_DEVICE_NAME);
    cJSON_AddStringToObject(body, "fw_version", BL_FW_VERSION);
    cJSON_AddItemToObject(body, "parts", parts_json ? parts_json : cJSON_CreateObject());
    return envelope("profile", ts, body);
}

cJSON *bl_build_part(const char *description, int home_pulse_us,
                     cJSON *params_json) {
    cJSON *p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "description", description);
    cJSON *home = cJSON_CreateObject();
    cJSON_AddNumberToObject(home, "pulse_width_us", home_pulse_us);
    cJSON_AddItemToObject(p, "home", home);
    cJSON_AddItemToObject(p, "params",
                          params_json ? params_json : cJSON_CreateObject());
    return p;
}

cJSON *bl_build_param_spec(const char *type, const char *unit,
                           double range_lo, double range_hi,
                           double default_val,
                           const char *description) {
    cJSON *p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "type", type);
    cJSON_AddStringToObject(p, "unit", unit);

    cJSON *range = cJSON_CreateArray();
    cJSON_AddItemToArray(range, isnan(range_lo) ? cJSON_CreateNull() : cJSON_CreateNumber(range_lo));
    cJSON_AddItemToArray(range, isnan(range_hi) ? cJSON_CreateNull() : cJSON_CreateNumber(range_hi));
    cJSON_AddItemToObject(p, "range", range);

    if (!isnan(default_val)) {
        cJSON_AddNumberToObject(p, "default", default_val);
    }
    if (description && *description) {
        cJSON_AddStringToObject(p, "description", description);
    }
    return p;
}

char *bl_enc_error(int ts, const char *code, const char *message, bool fatal) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "code",    code);
    cJSON_AddStringToObject(body, "message", message ? message : "");
    cJSON_AddBoolToObject(body,   "fatal",   fatal);
    return envelope("error", ts, body);
}

char *bl_enc_echo_reply(const char *id, int ts,
                        int seq, long long host_ts, long long device_ts) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddNumberToObject(body, "seq",       seq);
    cJSON_AddNumberToObject(body, "host_ts",   (double)host_ts);
    cJSON_AddNumberToObject(body, "device_ts", (double)device_ts);
    return envelope_with_id("echo_reply", id, ts, body);
}

char *bl_enc_applied(const char *id, int ts, const char *status) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "status", status ? status : "applied");
    return envelope_with_id("applied", id, ts, body);
}

// ── Decoders ────────────────────────────────────────────────────────────

cJSON *bl_parse(const char *payload, size_t len) {
    return cJSON_ParseWithLength(payload, len);
}

int bl_env_v(const cJSON *env) {
    cJSON *v = cJSON_GetObjectItemCaseSensitive((cJSON *)env, "v");
    if (!cJSON_IsNumber(v)) return -1;
    return (int)v->valuedouble;
}

const char *bl_env_type(const cJSON *env) {
    cJSON *t = cJSON_GetObjectItemCaseSensitive((cJSON *)env, "type");
    if (!cJSON_IsString(t)) return NULL;
    return t->valuestring;
}

const char *bl_env_id(const cJSON *env) {
    cJSON *i = cJSON_GetObjectItemCaseSensitive((cJSON *)env, "id");
    if (!cJSON_IsString(i)) return NULL;
    return i->valuestring;
}

cJSON *bl_env_body(cJSON *env) {
    cJSON *b = cJSON_GetObjectItemCaseSensitive(env, "body");
    if (!cJSON_IsObject(b)) return NULL;
    return b;
}

bool bl_hello_offers_v0(const cJSON *body) {
    if (!body) return false;
    cJSON *protos = cJSON_GetObjectItemCaseSensitive((cJSON *)body, "protos");
    if (!cJSON_IsArray(protos)) return false;
    cJSON *p;
    cJSON_ArrayForEach(p, protos) {
        if (cJSON_IsNumber(p) && (int)p->valuedouble == 0) return true;
    }
    return false;
}
