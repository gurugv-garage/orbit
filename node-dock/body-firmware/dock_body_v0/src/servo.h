// Servo driver — four MG90S on the XIAO ESP32-S3 via mcpwm.
//
// Wiring (locked):
//   neck      brown → GND, red → 5V, orange → GPIO 3   (was FL)
//   foot      brown → GND, red → 5V, orange → GPIO 4   (was FR)
//   arm_left  brown → GND, red → 5V, orange → GPIO 5   (was BL)
//   arm_right brown → GND, red → 5V, orange → GPIO 6   (was BR)
//
// Names map to the dock's MJCF joints. Smoke firmware (M4) only commands
// `neck` and `foot`; arm_left and arm_right are initialized + held at
// center but not advertised in the BodyLink profile until they're
// mechanically wired.

#pragma once

#include "esp_err.h"
#include "driver/gpio.h"

// Pin map. Edit here if wiring changes.
#define SERVO_NECK_GPIO       GPIO_NUM_3
#define SERVO_FOOT_GPIO       GPIO_NUM_4
#define SERVO_ARM_LEFT_GPIO   GPIO_NUM_5
#define SERVO_ARM_RIGHT_GPIO  GPIO_NUM_6

typedef enum {
    SERVO_NECK = 0,
    SERVO_FOOT,
    SERVO_ARM_LEFT,
    SERVO_ARM_RIGHT,
    SERVO_COUNT
} servo_id_t;

// Returns a stable short label for logging: "neck", "foot", "arm_left", "arm_right".
const char *servo_name(servo_id_t id);

// Init all four servos. Allocates mcpwm timer + operators + comparators
// + generators; writes 1500 µs (center) so they hold a known pose
// immediately. Returns ESP_OK on success, an esp_err otherwise.
esp_err_t servo_init_all(void);

// Command an absolute pulse width in microseconds. Clamps to
// [500, 2500] (MG90S safe range). Synchronous: returns after the
// comparator value is updated; physical motion lags by ~ms.
esp_err_t servo_write_us(servo_id_t id, int us);
