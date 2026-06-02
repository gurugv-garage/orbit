// BodyLink motion layer — per-part runtime, set_target dispatch,
// 10 ms motion tick. See ../../bodylink/DESIGN.md.
//
// All public functions take an internal mutex while reading/mutating state.
// Keep them short; servo_write_us is the only "outside" call inside the
// critical section and it's a microsecond-scale comparator update.

#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "cJSON.h"
#include "servo.h"

// ── Capability profile (compile-time, smoke version) ───────────────────

// One advertised parameter on a part.
typedef struct {
    const char  *name;          // "pulse_width_us"
    const char  *unit;          // "us"
    const char  *type;          // "int" | "float"
    double       range_lo;      // NAN = unbounded
    double       range_hi;      // NAN = unbounded
    double       def;           // NAN = no default
    const char  *description;
} bl_param_spec_t;

typedef struct {
    const char            *name;         // "neck", "foot"
    const char            *description;
    servo_id_t             servo_id;     // which physical servo
    int                    home_pulse_us;
    const bl_param_spec_t *params;
    int                    n_params;
} bl_part_decl_t;

extern const bl_part_decl_t g_bl_parts[];
extern const int             g_bl_n_parts;

// ── Errors / events the motion layer may emit ──────────────────────────

typedef enum {
    BL_EMIT_NONE = 0,
    BL_EMIT_UNKNOWN_PART,        // error
    BL_EMIT_UNKNOWN_PARAM,       // error
    BL_EMIT_OUT_OF_RANGE,        // error + clipped event
} bl_emit_kind_t;

typedef struct {
    bl_emit_kind_t kind;
    char           part[24];     // empty if N/A
    char           param[32];    // empty if N/A
    double         requested;
    double         applied;      // post-clamp value
} bl_emit_t;

// ── Init / clock ───────────────────────────────────────────────────────

esp_err_t bl_motion_init(void);
int       bl_motion_body_clock_ms(void);

// ── Command handler (called from WS layer) ─────────────────────────────

// Apply a `set_target` body: `body.parts` is a map of `{part: {param: val}}`.
//
// Per-part idempotent: a part whose target values match the current
// commanded target is a no-op (no transition restart). That makes it
// safe for the brain to use this single message for both immediate
// intent updates AND periodic heartbeats.
//
// Writes up to max_out emits to `out` (silently truncates if it
// overflows — pick max_out generously, e.g. 16). Returns the number
// written.
//
// If `changed_out` is non-NULL, sets *changed_out = 1 iff at least one
// part started a new transition (i.e. wasn't a no-op against current
// target). 0 otherwise. Drives the per-message `applied` ack — see
// DESIGN.md §3.2.
int bl_motion_set_target(const cJSON *body, bl_emit_t *out, int max_out,
                         int *changed_out);

// ── Motion tick (called from a dedicated FreeRTOS task at ~100 Hz) ─────

// Advance each part's current pulse_width_us toward target via linear
// interp over its duration_ms. Marks `settled` once elapsed >= duration.
// Writes new µs to the servo when current changes.
void bl_motion_tick(void);
