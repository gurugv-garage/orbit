// M3 servo driver implementation — see servo.h for the wire map +
// API contract.
//
// Layout in mcpwm (ESP-IDF v5.x):
//   1 timer (50 Hz, 1 µs tick — so the period is 20 000 ticks)
//     → 2 operators per timer (mcpwm hardware limit)
//        → 1 comparator per operator
//           → 1 generator per operator (drives one GPIO)
//
// 4 servos × 1 generator each = 4 operators total, which is exactly
// the per-group limit (mcpwm group 0 has 3 operators on ESP32-S3,
// group 1 has 3 more). We use group 0 for neck/foot/arm_left and
// group 1 for arm_right to stay within hardware limits.

#include "servo.h"

#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/mcpwm_prelude.h"

static const char *TAG = "servo";

// 50 Hz hobby servo timing.
#define SERVO_PWM_FREQ_HZ        50
#define SERVO_TIMER_RESOLUTION   1000000  // 1 µs ticks
#define SERVO_PERIOD_TICKS       (SERVO_TIMER_RESOLUTION / SERVO_PWM_FREQ_HZ)  // 20000
#define SERVO_US_MIN             500
#define SERVO_US_MAX             2500
#define SERVO_US_CENTER          1500

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
static const char *const s_names[SERVO_COUNT] = {
    "neck", "foot", "arm_left", "arm_right",
};

// Group assignment: ESP32-S3 has 2 mcpwm groups, each with up to 3
// operators. We need 4 servos → split 3 + 1 across groups.
static const int s_group_of[SERVO_COUNT] = { 0, 0, 0, 1 };
static const gpio_num_t s_pin_of[SERVO_COUNT] = {
    SERVO_NECK_GPIO, SERVO_FOOT_GPIO, SERVO_ARM_LEFT_GPIO, SERVO_ARM_RIGHT_GPIO,
};

// One timer per group, shared by the operators in that group.
static mcpwm_timer_handle_t s_group_timer[2] = { NULL, NULL };

const char *servo_name(servo_id_t id) {
    if ((unsigned)id >= SERVO_COUNT) return "??";
    return s_names[id];
}

static int clamp_us(int us) {
    if (us < SERVO_US_MIN) return SERVO_US_MIN;
    if (us > SERVO_US_MAX) return SERVO_US_MAX;
    return us;
}

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
    ESP_LOGI(TAG, "all %d servos initialized — holding at center", SERVO_COUNT);
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
