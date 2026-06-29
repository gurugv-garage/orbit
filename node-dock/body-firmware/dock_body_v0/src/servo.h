// Servo driver — four MG90S, board-agnostic API over two PWM backends.
//
// Backend is selected at build time by the IDF target (see servo.c):
//   ESP32-S3  → mcpwm  (XIAO ESP32-S3, 8 MB flash)
//   ESP32-C3  → ledc   (C3 mini, 4 MB flash; C3 has no mcpwm peripheral)
// The rest of the firmware only ever calls the API below, so the backend
// swap is invisible above this header.
//
// Wiring (locked) — same GPIOs on both boards; 3/4/5/6 are general-purpose
// pins on S3 and C3 alike (none are strapping pins on either chip):
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
//
// NOTE: the C3 SuperMini's pads differ from the XIAO S3. These GPIO numbers are
// the SAME on both chips electrically, but land on differently-placed pads. On
// the C3, GPIO 3/4 are clean general-purpose pads (left side, silkscreen "3"/"4").
// AVOID GPIO 2/8/9 on the C3 — they are strapping pins (8 is also the onboard LED)
// and driving a servo there can block boot/flash.
// C3 SuperMini and XIAO S3 share the same GPIO numbers here (3/4/5/6) — all
// clean general-purpose pads on both. On the C3 SuperMini these are the left-side
// pads silkscreened "3"/"4"/... AVOID GPIO 2/8/9 on the C3 (strapping; 8 is the
// onboard LED) — driving a servo there can block boot/flash.
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

// Init all four servos on the active PWM backend; writes 1500 µs (center)
// so they hold a known pose immediately. Returns ESP_OK on success, an
// esp_err otherwise.
esp_err_t servo_init_all(void);

// Command an absolute pulse width in microseconds. Clamps to
// [500, 2500] (MG90S safe range). Synchronous: returns after the PWM
// duty is updated; physical motion lags by ~ms.
esp_err_t servo_write_us(servo_id_t id, int us);

// Wiring smoke test: move each servo in turn (center → a gentle min → max →
// back to center), logging which servo + GPIO it's driving, so you can watch
// the physical bot and confirm each joint is on the pad you think it is. Blocks
// for a few seconds. Opt-in: main.c only calls it under -DBL_SERVO_SWEEP.
void servo_sweep_test(void);
