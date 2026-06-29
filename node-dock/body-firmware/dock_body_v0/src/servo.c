// Servo driver implementation — see servo.h for the wire map + API contract.
//
// Two PWM backends, selected by IDF target at compile time:
//   ESP32-S3 → mcpwm  (the original M3 driver)
//   ESP32-C3 → ledc   (C3 has no mcpwm peripheral; uses LED PWM controller)
// Both present the identical servo_init_all / servo_write_us / servo_name
// surface, so bodylink_motion.c et al. never know which one is compiled in.
//
// Common pieces (names, pin map, µs clamp) are shared by both backends.

#include "servo.h"

#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "servo";

// 50 Hz hobby servo timing — shared across backends.
#define SERVO_PWM_FREQ_HZ        50
#define SERVO_US_MIN             500
#define SERVO_US_MAX             2500
#define SERVO_US_CENTER          1500

// ── Shared: names, pin map, clamp ─────────────────────────────────────
static const char *const s_names[SERVO_COUNT] = {
    "neck", "foot", "arm_left", "arm_right",
};
static const gpio_num_t s_pin_of[SERVO_COUNT] = {
    SERVO_NECK_GPIO, SERVO_FOOT_GPIO, SERVO_ARM_LEFT_GPIO, SERVO_ARM_RIGHT_GPIO,
};

const char *servo_name(servo_id_t id) {
    if ((unsigned)id >= SERVO_COUNT) return "??";
    return s_names[id];
}

static int clamp_us(int us) {
    if (us < SERVO_US_MIN) return SERVO_US_MIN;
    if (us > SERVO_US_MAX) return SERVO_US_MAX;
    return us;
}

// Wiring smoke test — backend-agnostic (uses only the public API). One servo at
// a time so you can tell which physical joint moves and check it against the pad
// you wired. A GENTLE range (±400 µs, not the full ±1000) to avoid slamming an
// unknown/loaded horn into a hard stop on first power-up.
void servo_sweep_test(void) {
    const int lo = SERVO_US_CENTER - 400;   // 1100 µs
    const int hi = SERVO_US_CENTER + 400;   // 1900 µs
    // Move-then-hold, neck then foot: reach each pose and hold 2 s. With the board
    // soldered (solid contact) this should be smooth and settle at each position.
    ESP_LOGW(TAG, "── servo move test: neck then foot, hold 2 s each ──");
    for (int i = 0; i < 2; ++i) {   // neck, foot
        const int seq[] = { SERVO_US_CENTER, lo, SERVO_US_CENTER, hi, SERVO_US_CENTER };
        for (int k = 0; k < 5; ++k) {
            ESP_LOGW(TAG, "[%s] GPIO %d → %d us", s_names[i], (int)s_pin_of[i], seq[k]);
            servo_write_us((servo_id_t)i, seq[k]);
            vTaskDelay(pdMS_TO_TICKS(2000));
        }
    }
    ESP_LOGW(TAG, "── move test done — neck+foot at center ──");
}

// ══════════════════════════════════════════════════════════════════════
//  ESP32-S3 backend — mcpwm
// ══════════════════════════════════════════════════════════════════════
//
// Layout in mcpwm (ESP-IDF v5.x):
//   1 timer (50 Hz, 1 µs tick — so the period is 20 000 ticks)
//     → 1 operator + comparator + generator per servo (drives one GPIO)
//
// 4 servos → 4 operators. mcpwm group 0 has 3 operators on ESP32-S3,
// group 1 has 3 more. We use group 0 for neck/foot/arm_left and group 1
// for arm_right to stay within hardware limits.
#if CONFIG_IDF_TARGET_ESP32S3

#include "driver/mcpwm_prelude.h"

#define SERVO_TIMER_RESOLUTION   1000000  // 1 µs ticks
#define SERVO_PERIOD_TICKS       (SERVO_TIMER_RESOLUTION / SERVO_PWM_FREQ_HZ)  // 20000

typedef struct {
    gpio_num_t              pin;
    int                     group_id;     // mcpwm group 0 or 1
    mcpwm_timer_handle_t    timer;
    mcpwm_oper_handle_t     oper;
    mcpwm_cmpr_handle_t     comparator;
    mcpwm_gen_handle_t      generator;
    int                     current_us;
} servo_ctx_t;

static servo_ctx_t s_servos[SERVO_COUNT];

// Group assignment: ESP32-S3 has 2 mcpwm groups, each with up to 3
// operators. We need 4 servos → split 3 + 1 across groups.
static const int s_group_of[SERVO_COUNT] = { 0, 0, 0, 1 };

// One timer per group, shared by the operators in that group.
static mcpwm_timer_handle_t s_group_timer[2] = { NULL, NULL };

// Create (or reuse) the timer for a given mcpwm group.
static esp_err_t get_or_create_group_timer(int group_id,
                                           mcpwm_timer_handle_t *out) {
    if (s_group_timer[group_id]) {
        *out = s_group_timer[group_id];
        return ESP_OK;
    }
    mcpwm_timer_config_t tcfg = {
        .group_id      = group_id,
        .clk_src       = MCPWM_TIMER_CLK_SRC_DEFAULT,
        .resolution_hz = SERVO_TIMER_RESOLUTION,
        .period_ticks  = SERVO_PERIOD_TICKS,
        .count_mode    = MCPWM_TIMER_COUNT_MODE_UP,
    };
    esp_err_t r = mcpwm_new_timer(&tcfg, out);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "mcpwm_new_timer(group=%d) failed: %s",
                 group_id, esp_err_to_name(r));
        return r;
    }
    ESP_ERROR_CHECK(mcpwm_timer_enable(*out));
    ESP_ERROR_CHECK(mcpwm_timer_start_stop(*out, MCPWM_TIMER_START_NO_STOP));
    s_group_timer[group_id] = *out;
    return ESP_OK;
}

static esp_err_t init_one(servo_id_t id) {
    servo_ctx_t *s = &s_servos[id];
    s->pin       = s_pin_of[id];
    s->group_id  = s_group_of[id];
    s->current_us = SERVO_US_CENTER;

    // Timer (shared per group).
    esp_err_t r = get_or_create_group_timer(s->group_id, &s->timer);
    if (r != ESP_OK) return r;

    // Operator on the same group.
    mcpwm_operator_config_t ocfg = { .group_id = s->group_id };
    r = mcpwm_new_operator(&ocfg, &s->oper);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "[%s] mcpwm_new_operator failed: %s",
                 s_names[id], esp_err_to_name(r));
        return r;
    }
    ESP_ERROR_CHECK(mcpwm_operator_connect_timer(s->oper, s->timer));

    // Comparator — sets the pulse high-time.
    mcpwm_comparator_config_t ccfg = { .flags.update_cmp_on_tez = true };
    ESP_ERROR_CHECK(mcpwm_new_comparator(s->oper, &ccfg, &s->comparator));

    // Generator — drives the GPIO pin.
    mcpwm_generator_config_t gcfg = { .gen_gpio_num = s->pin };
    ESP_ERROR_CHECK(mcpwm_new_generator(s->oper, &gcfg, &s->generator));

    // Action: HIGH at timer=0, LOW when timer crosses comparator → pulse.
    ESP_ERROR_CHECK(mcpwm_generator_set_action_on_timer_event(
        s->generator,
        MCPWM_GEN_TIMER_EVENT_ACTION(
            MCPWM_TIMER_DIRECTION_UP,
            MCPWM_TIMER_EVENT_EMPTY,
            MCPWM_GEN_ACTION_HIGH)));
    ESP_ERROR_CHECK(mcpwm_generator_set_action_on_compare_event(
        s->generator,
        MCPWM_GEN_COMPARE_EVENT_ACTION(
            MCPWM_TIMER_DIRECTION_UP,
            s->comparator,
            MCPWM_GEN_ACTION_LOW)));

    // Initial pose: center.
    ESP_ERROR_CHECK(mcpwm_comparator_set_compare_value(s->comparator,
                                                       SERVO_US_CENTER));

    ESP_LOGI(TAG, "[%s] init on GPIO %d (group %d) — at %d µs",
             s_names[id], (int)s->pin, s->group_id, SERVO_US_CENTER);
    return ESP_OK;
}

esp_err_t servo_init_all(void) {
    memset(s_servos, 0, sizeof(s_servos));
    s_group_timer[0] = s_group_timer[1] = NULL;
    for (int i = 0; i < SERVO_COUNT; ++i) {
        esp_err_t r = init_one((servo_id_t)i);
        if (r != ESP_OK) {
            ESP_LOGE(TAG, "init failed at servo %s", s_names[i]);
            return r;
        }
    }
    ESP_LOGI(TAG, "all %d servos initialized (mcpwm) — holding at center",
             SERVO_COUNT);
    return ESP_OK;
}

esp_err_t servo_write_us(servo_id_t id, int us) {
    if ((unsigned)id >= SERVO_COUNT) return ESP_ERR_INVALID_ARG;
    servo_ctx_t *s = &s_servos[id];
    if (!s->comparator) return ESP_ERR_INVALID_STATE;
    int clamped = clamp_us(us);
    esp_err_t r = mcpwm_comparator_set_compare_value(s->comparator, clamped);
    if (r == ESP_OK) {
        s->current_us = clamped;
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════
//  ESP32-C3 backend — ledc
// ══════════════════════════════════════════════════════════════════════
//
// The C3 has no mcpwm; it has LEDC (LED PWM controller), which is the
// standard hobby-servo PWM source on C3. One 50 Hz timer drives up to 6
// channels — one channel per servo, all on the same timer.
//
// LEDC's duty is a raw count over 2^DUTY_RES, not a µs comparator. We pick
// 14-bit resolution: at 50 Hz that's 16384 counts per 20 000 µs period,
// i.e. ~0.81 counts/µs — finer than a servo's mechanical resolution. A
// pulse of `us` maps to duty = us * 2^DUTY_RES / 20000.
#elif CONFIG_IDF_TARGET_ESP32C3

#include "driver/ledc.h"

#define SERVO_LEDC_MODE        LEDC_LOW_SPEED_MODE   // C3 only has low-speed
#define SERVO_LEDC_TIMER       LEDC_TIMER_0
#define SERVO_LEDC_DUTY_RES    LEDC_TIMER_14_BIT
#define SERVO_PERIOD_US        (1000000 / SERVO_PWM_FREQ_HZ)   // 20000

typedef struct {
    gpio_num_t        pin;
    ledc_channel_t    channel;
    int               current_us;
    bool              ready;
} servo_ctx_t;

static servo_ctx_t s_servos[SERVO_COUNT];

// Channel assignment — one LEDC channel per servo, all on LEDC_TIMER_0.
static const ledc_channel_t s_channel_of[SERVO_COUNT] = {
    LEDC_CHANNEL_0, LEDC_CHANNEL_1, LEDC_CHANNEL_2, LEDC_CHANNEL_3,
};

// µs pulse-width → LEDC duty count (over the 2^DUTY_RES period).
static uint32_t us_to_duty(int us) {
    uint32_t max_duty = (1u << SERVO_LEDC_DUTY_RES);   // counts per full period
    return (uint32_t)((uint64_t)us * max_duty / SERVO_PERIOD_US);
}

static esp_err_t init_one(servo_id_t id) {
    servo_ctx_t *s = &s_servos[id];
    s->pin        = s_pin_of[id];
    s->channel    = s_channel_of[id];
    s->current_us = SERVO_US_CENTER;

    ledc_channel_config_t ccfg = {
        .gpio_num   = s->pin,
        .speed_mode = SERVO_LEDC_MODE,
        .channel    = s->channel,
        .timer_sel  = SERVO_LEDC_TIMER,
        .intr_type  = LEDC_INTR_DISABLE,
        .duty       = us_to_duty(SERVO_US_CENTER),
        .hpoint     = 0,
    };
    esp_err_t r = ledc_channel_config(&ccfg);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "[%s] ledc_channel_config failed: %s",
                 s_names[id], esp_err_to_name(r));
        return r;
    }
    s->ready = true;
    ESP_LOGI(TAG, "[%s] init on GPIO %d (ledc ch %d) — at %d µs",
             s_names[id], (int)s->pin, (int)s->channel, SERVO_US_CENTER);
    return ESP_OK;
}

esp_err_t servo_init_all(void) {
    memset(s_servos, 0, sizeof(s_servos));

    // One shared 50 Hz timer for all servo channels.
    ledc_timer_config_t tcfg = {
        .speed_mode      = SERVO_LEDC_MODE,
        .timer_num       = SERVO_LEDC_TIMER,
        .duty_resolution = SERVO_LEDC_DUTY_RES,
        .freq_hz         = SERVO_PWM_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    esp_err_t r = ledc_timer_config(&tcfg);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config failed: %s", esp_err_to_name(r));
        return r;
    }

    for (int i = 0; i < SERVO_COUNT; ++i) {
        r = init_one((servo_id_t)i);
        if (r != ESP_OK) {
            ESP_LOGE(TAG, "init failed at servo %s", s_names[i]);
            return r;
        }
    }
    ESP_LOGI(TAG, "all %d servos initialized (ledc) — holding at center",
             SERVO_COUNT);
    return ESP_OK;
}

esp_err_t servo_write_us(servo_id_t id, int us) {
    if ((unsigned)id >= SERVO_COUNT) return ESP_ERR_INVALID_ARG;
    servo_ctx_t *s = &s_servos[id];
    if (!s->ready) return ESP_ERR_INVALID_STATE;
    int clamped = clamp_us(us);
    esp_err_t r = ledc_set_duty(SERVO_LEDC_MODE, s->channel, us_to_duty(clamped));
    if (r != ESP_OK) return r;
    r = ledc_update_duty(SERVO_LEDC_MODE, s->channel);
    if (r == ESP_OK) {
        s->current_us = clamped;
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════
#else
#error "servo.c: unsupported IDF target — add a PWM backend for this chip"
#endif
