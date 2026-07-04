// BodyLink motion layer — implementation. See bodylink_motion.h.

#include "bodylink_motion.h"

#include <math.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "bl_motion";

// ── Smoke profile (compile-time) ───────────────────────────────────────
//
// Two parts wired in M4: neck (servo 0, GPIO 3) and foot (servo 1, GPIO 4).
// arm_left and arm_right exist in hardware but aren't advertised in the
// profile yet — they hold center until they get their own part entries.

static const bl_param_spec_t neck_params[] = {
    { "pulse_width_us",          "us",   "int",  500.0,  2500.0, NAN,
      "Servo PWM pulse width. 1500 µs is mechanical center." },
    { "duration_ms",             "ms",   "int",  0.0,    30000.0, 400.0,
      "Linear interpolation time to reach target pulse_width_us. 0 = snap." },
    { "velocity_us_per_sec_cap", "us/s", "int",  0.0,    4000.0,  3000.0,
      "Max rate of change. 0 = use device default." },
};
static const bl_param_spec_t foot_params[] = {
    { "pulse_width_us",          "us",   "int",  500.0,  2500.0, NAN,
      "Servo PWM pulse width. 1500 µs is mechanical center." },
    { "duration_ms",             "ms",   "int",  0.0,    30000.0, 400.0,
      "Linear interpolation time to reach target pulse_width_us. 0 = snap." },
    { "velocity_us_per_sec_cap", "us/s", "int",  0.0,    4000.0,  3000.0,
      "Max rate of change. 0 = use device default." },
};

const bl_part_decl_t g_bl_parts[] = {
    { "neck", "Single-DOF pitch servo on the head — nods up/down. MG90S clone.",
      SERVO_NECK, 1500, neck_params, sizeof(neck_params) / sizeof(neck_params[0]) },
    { "foot", "Yaw servo at the base — turns the dock around its vertical axis.",
      SERVO_FOOT, 1500, foot_params, sizeof(foot_params) / sizeof(foot_params[0]) },
};
const int g_bl_n_parts = sizeof(g_bl_parts) / sizeof(g_bl_parts[0]);

// ── Per-part runtime ───────────────────────────────────────────────────

typedef struct {
    int   start_us;        // pulse_width_us at the start of the active transition
    int   target_us;       // pulse_width_us we're moving toward
    int   current_us;      // last value pushed to the servo
    int   duration_ms;     // total time for this transition (ease-in/out interp)
    int   velocity_cap;    // us/sec ceiling for this transition (0 = uncapped). Safety floor:
                           // a duration too short for the travel is stretched to honor it.
    int   started_ms;      // body-clock at transition start
    bool  settled;         // current_us == target_us, no motion in progress
} bl_part_rt_t;

// Ease-in/ease-out (smoothstep): maps linear progress f∈[0,1] to an S-curve so the
// servo accelerates off the start and decelerates into the target instead of slamming
// from 0→full-speed→0. Removes the endpoint jerk on big/fast sweeps (and the current
// spike that jerk causes on the C3's TX-power rail). Peak speed is 1.5× the linear
// average, so the velocity cap below is computed against that peak.
static inline double smoothstep(double f) {
    if (f <= 0.0) return 0.0;
    if (f >= 1.0) return 1.0;
    return f * f * (3.0 - 2.0 * f);
}

static bl_part_rt_t s_rt[8];           // sized > g_bl_n_parts
static int          s_boot_ms = 0;
static SemaphoreHandle_t s_mtx = NULL;

// ── Helpers ────────────────────────────────────────────────────────────

int bl_motion_body_clock_ms(void) {
    return (int)((esp_timer_get_time() / 1000) - s_boot_ms);
}

int bl_motion_current_us(int idx) {
    if (idx < 0 || idx >= g_bl_n_parts) return -1;
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    int us = s_rt[idx].current_us;
    xSemaphoreGive(s_mtx);
    return us;
}

static const bl_part_decl_t *find_part(const char *name, int *out_idx) {
    if (!name) return NULL;
    for (int i = 0; i < g_bl_n_parts; ++i) {
        if (strcmp(g_bl_parts[i].name, name) == 0) {
            if (out_idx) *out_idx = i;
            return &g_bl_parts[i];
        }
    }
    return NULL;
}

static const bl_param_spec_t *find_param(const bl_part_decl_t *p, const char *name) {
    for (int i = 0; i < p->n_params; ++i) {
        if (strcmp(p->params[i].name, name) == 0) return &p->params[i];
    }
    return NULL;
}

// Returns clipped value via *applied. Sets *was_clipped if it differed.
static double clamp_param(const bl_param_spec_t *spec, double v, bool *was_clipped) {
    double out = v;
    *was_clipped = false;
    if (!isnan(spec->range_lo) && out < spec->range_lo) { out = spec->range_lo; *was_clipped = true; }
    if (!isnan(spec->range_hi) && out > spec->range_hi) { out = spec->range_hi; *was_clipped = true; }
    if (strcmp(spec->type, "int") == 0) out = (double)(int)(out + (out >= 0 ? 0.5 : -0.5));
    return out;
}

static void emit_set(bl_emit_t *e, bl_emit_kind_t k, const char *part, const char *param,
                     double req, double app) {
    e->kind = k;
    e->part[0] = e->param[0] = 0;
    if (part)  strncpy(e->part,  part,  sizeof(e->part)  - 1);
    if (param) strncpy(e->param, param, sizeof(e->param) - 1);
    e->requested = req;
    e->applied   = app;
}

// ── Init ───────────────────────────────────────────────────────────────

esp_err_t bl_motion_init(void) {
    if (!s_mtx) {
        s_mtx = xSemaphoreCreateMutex();
        if (!s_mtx) return ESP_ERR_NO_MEM;
    }
    s_boot_ms = (int)(esp_timer_get_time() / 1000);

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    for (int i = 0; i < g_bl_n_parts; ++i) {
        bl_part_rt_t *rt = &s_rt[i];
        rt->start_us     = g_bl_parts[i].home_pulse_us;
        rt->target_us    = g_bl_parts[i].home_pulse_us;
        rt->current_us   = g_bl_parts[i].home_pulse_us;
        rt->duration_ms  = 0;
        rt->velocity_cap = 0;
        rt->started_ms   = 0;
        rt->settled      = true;
        servo_write_us(g_bl_parts[i].servo_id, rt->current_us);
        ESP_LOGI(TAG, "[%s] parked at home %d µs", g_bl_parts[i].name, rt->current_us);
    }
    xSemaphoreGive(s_mtx);
    return ESP_OK;
}

// ── Internal: apply (part_idx, {param: value, ...}) ────────────────────
//
// Called by both set_param and set_target. Walks the body's keys (skipping
// `part`/`parts`), validates them against the part's param specs, clamps,
// and — when at least one valid parameter changed — starts a new transition.
//
// Returns the number of emits written.

// changed_out (optional): set to 1 if a new transition was started for this
// part (i.e. target differed from current and we preempted). Untouched
// otherwise so the caller can OR across parts.
static int apply_to_part(const bl_part_decl_t *part, int part_idx, const cJSON *body,
                         bl_emit_t *out, int max_out, int *changed_out) {
    int n_emit = 0;
    int duration_ms = -1;            // "not specified"
    int velocity_cap = -1;           // "not specified" (us/sec; 0 = uncapped)
    int new_pulse_us = -1;
    bool have_new_pulse = false;

    // Walk body keys.
    cJSON *child;
    cJSON_ArrayForEach(child, body) {
        const char *key = child->string;
        if (!key) continue;
        // Skip envelope-level / addressing keys.
        if (strcmp(key, "part") == 0 || strcmp(key, "parts") == 0) continue;

        const bl_param_spec_t *spec = find_param(part, key);
        if (!spec) {
            if (n_emit < max_out) {
                emit_set(&out[n_emit++], BL_EMIT_UNKNOWN_PARAM, part->name, key, NAN, NAN);
            }
            continue;
        }

        if (!cJSON_IsNumber(child)) {
            // Best-effort: treat as out-of-range emit. Could become BAD_MESSAGE
            // but UNKNOWN_PARAM-style telemetry is friendlier and easy.
            if (n_emit < max_out) {
                emit_set(&out[n_emit++], BL_EMIT_OUT_OF_RANGE, part->name, key, NAN, NAN);
            }
            continue;
        }
        bool clipped = false;
        double applied = clamp_param(spec, child->valuedouble, &clipped);
        if (clipped && n_emit < max_out) {
            emit_set(&out[n_emit++], BL_EMIT_OUT_OF_RANGE, part->name, key,
                     child->valuedouble, applied);
        }

        if (strcmp(key, "pulse_width_us") == 0) {
            new_pulse_us = (int)applied;
            have_new_pulse = true;
        } else if (strcmp(key, "duration_ms") == 0) {
            duration_ms = (int)applied;
        } else if (strcmp(key, "velocity_us_per_sec_cap") == 0) {
            velocity_cap = (int)applied;
        }
    }

    if (!have_new_pulse) {
        // Nothing to actuate. set_target frequently sends only pulse_width_us;
        // a body with just duration_ms is a no-op.
        return n_emit;
    }

    if (duration_ms < 0) {
        // Use the part's default duration_ms (from spec.def).
        const bl_param_spec_t *dspec = find_param(part, "duration_ms");
        duration_ms = (dspec && !isnan(dspec->def)) ? (int)dspec->def : 400;
    }
    if (velocity_cap < 0) {
        // Use the part's default velocity_us_per_sec_cap (from spec.def).
        const bl_param_spec_t *vspec = find_param(part, "velocity_us_per_sec_cap");
        velocity_cap = (vspec && !isnan(vspec->def)) ? (int)vspec->def : 0;
    }

    // Idempotency: if target_us already matches AND we're settled (or moving
    // there), skip restart. This is what makes set_target spam cheap.
    bl_part_rt_t *rt = &s_rt[part_idx];
    if (rt->target_us == new_pulse_us) {
        // Already heading there (or settled there) — leave alone.
        return n_emit;
    }

    // Velocity cap = the un-bypassable safety floor. If the requested duration is
    // too short for the travel — a full sweep in duration_ms:0, say — STRETCH it so
    // peak speed stays under the cap, protecting the gear train + the C3 power rail
    // regardless of what the station sends. Smoothstep's peak speed is 1.5× the
    // linear average (travel/dur), so the shortest legal duration is
    //   1.5 · travel_us / cap_us_per_sec  (·1000 for ms).
    int travel = new_pulse_us - rt->current_us;
    if (travel < 0) travel = -travel;
    if (velocity_cap > 0 && travel > 0) {
        int min_dur = (int)((1500.0 * (double)travel) / (double)velocity_cap + 0.5);
        if (duration_ms < min_dur) {
            ESP_LOGD(TAG, "[%s] duration %d ms too fast for %d µs travel @ cap %d — stretch to %d ms",
                     part->name, duration_ms, travel, velocity_cap, min_dur);
            duration_ms = min_dur;
        }
    }

    // Preempt: capture current as start, set new target + clock.
    rt->start_us     = rt->current_us;
    rt->target_us    = new_pulse_us;
    rt->duration_ms  = duration_ms;
    rt->velocity_cap = velocity_cap;
    rt->started_ms   = bl_motion_body_clock_ms();
    rt->settled      = (duration_ms == 0);
    if (duration_ms == 0) {
        rt->current_us = new_pulse_us;
        servo_write_us(part->servo_id, new_pulse_us);
    }
    if (changed_out) *changed_out = 1;

    ESP_LOGI(TAG, "[%s] %d→%d µs over %d ms (cap %d µs/s)", part->name,
             rt->start_us, rt->target_us, rt->duration_ms, rt->velocity_cap);
    return n_emit;
}

// ── set_target ─────────────────────────────────────────────────────────

int bl_motion_set_target(const cJSON *body, bl_emit_t *out, int max_out,
                         int *changed_out) {
    int n_emit = 0;
    if (changed_out) *changed_out = 0;
    if (!body) return 0;
    cJSON *parts = cJSON_GetObjectItemCaseSensitive((cJSON *)body, "parts");
    if (!cJSON_IsObject(parts)) return 0;

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    cJSON *part_entry;
    cJSON_ArrayForEach(part_entry, parts) {
        if (!cJSON_IsObject(part_entry)) continue;
        const char *part_name = part_entry->string;
        int idx;
        const bl_part_decl_t *part = find_part(part_name, &idx);
        if (!part) {
            if (n_emit < max_out) {
                emit_set(&out[n_emit++], BL_EMIT_UNKNOWN_PART, part_name, "", NAN, NAN);
            }
            continue;
        }
        n_emit += apply_to_part(part, idx, part_entry,
                                &out[n_emit], max_out - n_emit, changed_out);
    }
    xSemaphoreGive(s_mtx);
    return n_emit;
}

// ── Motion tick ────────────────────────────────────────────────────────

void bl_motion_tick(void) {
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    int now = bl_motion_body_clock_ms();
    for (int i = 0; i < g_bl_n_parts; ++i) {
        bl_part_rt_t *rt = &s_rt[i];
        if (rt->settled) continue;
        int elapsed = now - rt->started_ms;
        int dur = rt->duration_ms;
        int next_us;
        if (dur <= 0 || elapsed >= dur) {
            next_us = rt->target_us;
            rt->settled = true;
        } else {
            // Ease-in/ease-out (smoothstep) from start to target: accelerate off the
            // start, decelerate into the target — no endpoint jerk. Duration is unchanged.
            double f = smoothstep((double)elapsed / (double)dur);
            next_us = (int)((double)rt->start_us +
                            (double)(rt->target_us - rt->start_us) * f + 0.5);
        }
        if (next_us != rt->current_us) {
            rt->current_us = next_us;
            servo_write_us(g_bl_parts[i].servo_id, next_us);
        }
    }
    xSemaphoreGive(s_mtx);
}
