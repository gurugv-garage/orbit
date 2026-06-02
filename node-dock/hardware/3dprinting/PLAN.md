# 3D-printing plan — node-dock shell

Source XML: [../../bodylink/sim/bodies/dock_humanoid.xml](../../bodylink/sim/bodies/dock_humanoid.xml)
Material: **PLA+** (all parts).
Target printer: any 220 × 220 × 250 mm FDM (Ender 3, Bambu A1, Prusa MK4).

## Modeling tool: OpenSCAD

Parametric, text-based, diffs in git. All shared dimensions live in
[scad/params.scad](scad/params.scad) — change a number, regenerate STLs.

### Generate STLs

```bash
brew install openscad         # one-time
cd node-dock/hardware/3dprinting
make                          # builds all STLs into stl/
```

## Parts list

| # | Part | File | Print orient. | Approx. time | Filament |
|---|---|---|---|---|---|
| 1 | Base, lower half | `base_lower.scad` | flat, open side up | 4 h | 70 g |
| 2 | Base, upper half | `base_upper.scad` | flat | 4 h | 70 g |
| 3 | Leg shaft (hollow) | `leg_shaft.scad` | vertical | 1.5 h | 25 g |
| 4 | Trunk, back shell | `trunk_back.scad` | flat, open side up | 3.5 h | 55 g |
| 5 | Trunk, front shell | `trunk_front.scad` | flat | 3.5 h | 55 g |
| 6 | Neck stub housing | `neck_stub.scad` | vertical | 1 h | 15 g |
| 7 | Head, back tray (phone cradle) | `head_back.scad` | flat | 3 h | 50 g |
| 8 | Head, front bezel | `head_front.scad` | flat | 2 h | 40 g |
| 9 | Shoulder bracket (×2) | `shoulder_bracket.scad` | flat | 0.5 h | 10 g |
| 10 | Arm (×2) | `arm.scad` | vertical | 1.5 h | 15 g |
| **Total** | | | | **~24 h** | **~405 g** |

## Print settings (PLA+)

- **Nozzle**: 0.4 mm
- **Layer height**: 0.2 mm (0.16 mm for head bezel — visible face)
- **Walls**: 3 (4 for base halves, leg shaft, shoulder brackets)
- **Infill**: 20% gyroid (40% for base halves and leg shaft)
- **Supports**: only on overhangs > 50°. With the recommended splits, nothing
  needs supports except optionally the arm capsule ends.
- **Brim**: 5 mm for the base halves (large flat parts curl).
- **Temp**: 215 °C nozzle / 60 °C bed.

## Tolerances

- Servo cavities: nominal datasheet dim + **0.3 mm** all around → snug press fit.
- Phone slot: phone outline + **0.5 mm**. Print a single test sleeve first.
- M3 screw holes: **3.3 mm** Ø clearance, **5.0 mm** Ø boss for heat-set insert.
- Alignment-peg holes (mating shell halves): printed Ø4 mm peg into Ø4.2 mm hole.

## Why each part is split

| Part | Why split |
|---|---|
| **Base (lower + upper)** | Ø240 mm exceeds 220 mm bed. Split horizontally at z=25 mm — joined by 6× M3 around the rim, no functional load across the seam. |
| **Trunk (back + front)** | Internal PCB standoffs / servo mounts need to be printed support-free. Splitting the box at the YZ plane lets the back shell carry every internal mount as a single-sided overhang-free print. |
| **Head (back tray + front bezel)** | Phone has to slot in from somewhere. Splitting at the phone's back plane creates an open cradle on the tray side and a thin retaining lip on the bezel side. Also keeps either half under 200 mm. |

## Open TODOs (deferred — address before printing)

These are known unresolved items from the first-pass parametric model. The
STLs in `stl/` build and are manifold, but should not go to the printer
until these are reviewed.

### Resolved on the MJCF side (sim agrees; SCAD-side may still need work)

- [x] **Switch shoulders from forward pitch to lateral abduction.** MJCF
      done as of commit `645343c` — both shoulder hinges on `axis="0 1 0"`,
      ranges `[-1.6, 0]` (left) and `[0, 1.6]` (right). Joint names kept
      as `shoulder_*_pitch` (with code comment noting the semantics) for
      backwards-compat with profiles + tests.
      - [ ] SCAD follow-up: rotate the SG90 cavity 90° in
        [scad/shoulder_bracket.scad](scad/shoulder_bracket.scad) so the
        output shaft exits the +Y face (toward viewer) instead of ±X;
        regenerate STL
      - [x] Sim profile updated — arm states are now `rest/out/raise/wave`
        (lateral). 30/30 integration tests pass.
- [x] **Drop neck_roll; pitch-only neck with MG90D.** MJCF done — single
      `neck_pitch` joint at `axis="1 0 0"`. Profile updated; head states
      are `center/lookUp/lookDown/nodYes`.
      - [ ] SCAD follow-up: in [scad/neck_stub.scad](scad/neck_stub.scad)
        remove the second servo cavity; neck_stub geometry can stay
        30×40×40 mm (still has the MG90D cavity). Regenerate STL.
- [x] **Tighten `foot_yaw` range.** Done — `range="-1.5708 1.5708"` in
      `dock_humanoid.xml` matches DS3218's ±90°. Profile's `foot.behind`
      (180°) replaced by `foot.away` (90° max).

### Still open (SCAD + assembly issues, no MJCF impact)

- [ ] **`trunk_front.stl` is suspiciously small (1.4 KB vs ~50 KB expected).**
      Likely the rim-clearance hole booleans removed too much geometry.
      Inspect `trunk_front.scad` first.
- [ ] **Visual review in OpenSCAD GUI.** No part has been eyeballed yet —
      open each `.scad` in the OpenSCAD app and confirm geometry matches
      intent (servo cavities oriented correctly, screw holes land on
      mating bosses, no floating geometry).
- [ ] **Reconcile neck_stub dimensions with the MJCF model.** Hardware
      uses 30×40×40 mm; XML still says 15×15×15 mm half-extents
      (= 30×30×30 mm). Either widen the XML to match the printed cavity
      or trim the SCAD. Cosmetic; doesn't affect kinematics.
- [ ] **Phone outline is iPhone-15-class.** `PHONE_X/Y/Z` in
      [scad/params.scad](scad/params.scad) is set to 165×9×76 mm.
      Re-measure the actual target phone and update before printing the
      head halves.
- [ ] **Verify mating-shell alignment.** Peg/hole positions in
      `base_lower`/`base_upper`, `trunk_back`/`trunk_front`, and
      `head_back`/`head_front` are mirrored by hand — confirm they line
      up by assembling the STLs in a slicer or CAD viewer.
- [ ] **Internal PCB-mount footprints are placeholders.** The 4-hole
      pattern in `trunk_back.scad` for the ESP32 is generic
      (26×48 mm) — confirm against the actual ESP32-WROOM-32 dev-board
      hole spacing before printing the back shell.
- [ ] **Cable-routing slack volume.** Base lower-half cavity does not yet
      model a cable-management spiral or hard-stop tab; ±90° firmware
      limit makes this survivable but ugly. Add later if it bothers us.
- [ ] **DS3218 mounting ears.** Cavity is a simple box; the servo's
      flanged mounting ears (`DS3218_EAR_W/T` in params) are unused.
      Either add ear slots in `base_lower.scad` or rely on a friction
      fit + bottom-screw retention.
- [ ] **Bezel screen window may need a cosmetic chamfer.** Currently a
      straight through-cut.

## Validation

After printing the first set:
1. Dry-fit each servo into its cavity — should slide in firmly without forcing.
2. Stack head halves around the phone with no electronics — verify the slot
   holds the phone snugly with the bezel screwed on.
3. Stack the whole assembly without wiring — verify nothing binds when each
   joint is moved by hand through its full range.
4. Then wire up and run the bodylink WS test (21 named states) end-to-end.
