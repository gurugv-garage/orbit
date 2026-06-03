# node-dock hardware

Physical-build artifacts for the dock companion robot.

> **Status (2026-05-27): this doc is speculative.** It predates the bring-up
> and describes the *target* full-DOF dock. The current bench setup that the
> firmware drives is different and minimal:
> - **MCU:** Seeed XIAO ESP32-S3 + u.FL antenna (not ESP32-WROOM-32 + PCA9685).
> - **Servos:** 4× MG90S (not the DS3218 / MG90D / SG90 mix below).
> - **Drive:** XIAO mcpwm directly on GPIO 3/4/5/6. No I²C PWM expander.
> - **Servo power:** external 5 V brick PSU — NOT the XIAO 5 V pin.
>
> Current working bench: [../body-firmware/dock_body_v0/progress.md](../body-firmware/dock_body_v0/progress.md).
> This page will be rewritten once we move from bench to a built dock.

## Target — 4 actuated DOF

Joints and ranges derived from the MJCF model
[../bodylink/sim/bodies/dock_humanoid.xml](../bodylink/sim/bodies/dock_humanoid.xml):

| Joint | Axis | Range | Notes |
|---|---|---|---|
| `foot_yaw` | Z | ±π/2 (tightened from ±π) | Whole-body swivel; left/right look. |
| `neck_pitch` | X | ±0.5 rad | Nod up/down. |
| `shoulder_left_pitch` | Y | 0..+π/2 (down → T-pose) | Lateral abduction, not forward pitch. |
| `shoulder_right_pitch` | Y | -π/2..0 (T-pose → down) | Mirror. |

`neck_roll` from the MJCF is intentionally **not built** — `foot_yaw` covers
left/right look. MJCF will be reconciled later. The `_pitch` suffix on
shoulder joint names is preserved for compatibility with older profiles even
though the kinematics are abduction.

Repo layout under this directory:

- [3dprinting/](3dprinting/) — printable shell parts (OpenSCAD source + STL exports). Active design notes in [3dprinting/PLAN.md](3dprinting/PLAN.md).

## Bill of materials (target, not bench)

### Actuators

> **AS BUILT: all four joints use MG90S micro servos** (what's actually wired —
> see `body-firmware/.../servo.h`). The DS3218/MG90D/SG90 mix in the table below
> is the *original spec'd* BOM and its torque/fit rationale; it does **not** match
> the current build. Practically: every joint is an MG90S driven 1:1, so each
> sweeps the servo's full ±90° over 500–2500µs (the brain's `DEGREE_RANGE` uses
> ±90° for both neck and foot). Re-spec to the metal-gear servos below only if the
> MG90S torque/precision proves insufficient under real load.

| Joint | Servo (spec'd) | Torque | Range | Why |
|---|---|---|---|---|
| foot_yaw | **DS3218** (180°, metal gear) | 20 kg·cm | ±90° | Rotates ~600 g upper body. Thrust bearing carries static weight. |
| neck_pitch | **MG90D** (digital micro, metal gear) | ~2.5 kg·cm | ±28.6° | Holds head + ~250 g phone (req ~1.25 kg·cm, 2× margin). Same envelope as MG90S → fits the 30×40×40 neck_stub cavity. MG996R doesn't fit (42.9 mm tall). |
| shoulder_left_pitch | **SG90** (plastic gear) | 1.2 kg·cm | 0..+π/2 | 60 mm decorative arm, negligible load. Axis Y (lateral). |
| shoulder_right_pitch | **SG90** | 1.2 kg·cm | -π/2..0 | Mirror. |

### Electronics (target)

| Item | Spec | Qty | Notes |
|---|---|---|---|
| MCU | ESP32-WROOM-32 dev board | 1 | Bench actually uses **XIAO ESP32-S3** + u.FL antenna. |
| PWM driver | PCA9685 16-channel I²C | 1 | Bench drives mcpwm directly — no expander needed. |
| Buck converter | 5 V / 5 A (MP1584 or DROK) | 1 | DS3218 can pull 1–2 A at stall. |
| Capacitor | 1000 µF / 16 V electrolytic | 1 | Across 5 V servo rail. |
| Power input | 12 V / 3 A barrel jack + DC socket | 1 | Desk-tethered. |

### Mechanical

| Item | Spec | Qty |
|---|---|---|
| Thrust bearing | F6-14M (6×14×5 mm) | 1 |
| M3 heat-set inserts | brass, 5 mm long | ~20 |
| M3 socket-head screws | 6/8/12 mm assorted | ~30 |
| Servo horns | metal 25T (for DS3218) | 2 |
| Servo horns | plastic (MG90S / SG90) | 3 |
| Alignment pegs | Ø4 mm × 8 mm dowel pins or printed | ~6 |

### Filament

| Item | Spec | Qty |
|---|---|---|
| PLA+ | 1 kg spool | 1 | ~405 g used; spare for reprints |

### Estimated total cost (USD, hobbyist sources, 2026)

- Servos: DS3218 ~$15, MG90D ~$6, 2× SG90 ~$5 → **$26**
- Electronics: ESP32 ~$8, PCA9685 ~$3, buck ~$3, jack/cap/wire ~$5 → **$19**
- Mechanical: bearing ~$2, inserts/screws ~$10, horns (often included with servos) → **$12**
- Filament: ~$20/kg → **$20** (one spool, reusable)
- **Total: ~$77** (excluding the phone, which the user supplies)

## Assembly (target build)

### Servo arrangement

```
                  ┌──────────────────┐
                  │  Phone (slotted) │   ← landscape, ~250 g
                  └──────────────────┘
                          │
                  ┌───────┴────────┐
                  │  Head cradle   │
                  │  ┌──────────┐  │
                  │  │ MG90D    │  │ ← neck_pitch (axis = X)
                  │  └──────────┘  │
                  └───────┬────────┘
                          │
   ┌──────────────────────┴──────────────────────┐
   │  Trunk (100×80×140)                         │
   │  ┌────────┐  ┌────────┐  ┌────────┐         │
   │  │ ESP32  │  │PCA9685 │  │ Buck   │         │
   │  └────────┘  └────────┘  └────────┘         │
   │   [SG90 L]                       [SG90 R]   │
   └──────────┬──────────────────────┬───────────┘
              │                      │
           arm_L                  arm_R
                          │
                  ┌───────┴────────┐
                  │  Leg shaft     │
                  │  + thrust brg  │
                  └───────┬────────┘
                          │
                  ┌───────┴────────┐
                  │  Base (Ø240)   │
                  │  ┌──────────┐  │
                  │  │ DS3218   │  │ ← foot_yaw (shaft up)
                  │  └──────────┘  │
                  │   12 V jack    │
                  └────────────────┘
```

### PCA9685 channel map (target — bench uses direct GPIO)

| Ch | Joint | Servo |
|---|---|---|
| 0 | foot_yaw | DS3218 |
| 1 | neck_pitch | MG90D |
| 2 | shoulder_left_pitch | SG90 |
| 3 | shoulder_right_pitch | SG90 |
| 4 | _(unused — reserved for future neck_roll if neck redesigned)_ | — |

**Shoulder axis convention:** abduction (lateral), not pitch (forward/back).
At θ=0 both arms hang straight down. Left arm raises to T-pose at θ=+π/2;
right arm raises to T-pose at θ=-π/2. Servo output shaft points
**forward (+Y)** out of the trunk, not sideways — the bracket cavity in
[3dprinting/scad/shoulder_bracket.scad](3dprinting/scad/shoulder_bracket.scad)
needs reorienting (deferred).

### Build order

1. **Print all parts** (see [3dprinting/](3dprinting/), ~24 h total).
2. **Install heat-set inserts** into every M3 boss while plastic is fresh.
3. **Base assembly**:
   - Drop DS3218 into base cavity, shaft up.
   - Mount thrust bearing on top of the base flange.
   - Couple leg shaft to DS3218 horn; leg shaft passes through bearing inner race.
   - Wire pigtail from PCA9685 (in trunk) down through hollow leg shaft.
4. **Trunk assembly**:
   - Mount ESP32, PCA9685, buck converter to back-shell standoffs.
   - Wire 12 V → buck → 5 V rail → PCA9685 V+ rail.
   - Wire ESP32 I²C (GPIO 21 SDA, 22 SCL) to PCA9685.
   - Press SG90s into shoulder brackets; route cables to PCA9685 ch 3, 4.
   - Close front shell with alignment pegs + 4× M3.
5. **Head assembly**:
   - Mount MG90D (pitch, axis X) inside neck_stub housing.
   - Route cable down through trunk to PCA9685 ch 1.
   - Attach head cradle to MG90D output horn (metal horn for the ~250 g phone load).
6. **Arms**: snap onto SG90 horns; tighten center screw.
7. **First power-on**:
   - All servos commanded to 0 rad (neutral).
   - Verify head level, arms hanging straight down, body facing forward.
   - Manually disengage any servo that's off-center and re-seat its horn.

### Wiring & cable management

- Upper-body servo cables (3 servos × 3 wires) run down through the hollow leg shaft.
- Add ~30 mm of slack inside the base so the bundle can twist ±90° without strain. Firmware enforces ±90° yaw limit so no wind-up accumulates.
- Power-distribute on a small protoboard or directly on PCA9685 V+ rail; do **NOT** power servos from ESP32's 5 V pin.

### Firmware integration

- The firmware speaks the BodyLink protocol — wire spec at [../bodylink/DESIGN.md](../bodylink/DESIGN.md).
- The body advertises **capabilities** in `profile` (parts + parameter ranges + home pose) — brain owns named states.
- Each part advertises `pulse_width_us` (range `[500, 2500]` µs default), `duration_ms`, and `velocity_us_per_sec_cap`. Body clamps to range and emits `OUT_OF_RANGE` + `event:clipped` on overflow.
- Apply XML joint limits per part as a tighter `pulse_width_us` range when the dock is built:
  - foot_yaw: ±π/2
  - neck_pitch: ±0.5 rad
  - shoulder_left_pitch: 0..+π/2 rad
  - shoulder_right_pitch: -π/2..0 rad
