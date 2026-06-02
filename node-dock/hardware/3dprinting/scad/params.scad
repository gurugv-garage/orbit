// Shared parameters for node-dock shell.
// All dimensions in millimeters. Sourced from
//   ../../bodylink/sim/bodies/dock_humanoid.xml
// where they are in meters.

// ── Global tolerances ────────────────────────────────────────────────
WALL        = 2.4;   // 3 perimeters at 0.4 mm nozzle / 0.2 mm layer
FIT         = 0.3;   // press-fit clearance on servo cavities
PHONE_FIT   = 0.5;   // clearance around phone outline
M3_CLEAR    = 3.3;   // M3 clearance hole
M3_INSERT_D = 5.0;   // heat-set insert outer Ø
M3_INSERT_H = 5.0;   // heat-set insert depth
PEG_D       = 4.0;   // alignment peg Ø (peg) / hole Ø is PEG_D + 0.2

$fn = 64;            // smooth curves by default

// ── Base ─────────────────────────────────────────────────────────────
BASE_D      = 240;
BASE_H      = 50;
BASE_SPLIT  = 25;    // halve the disc horizontally
BASE_FLANGE_D = 90;
BASE_FLANGE_H = 10;

// ── Leg shaft ────────────────────────────────────────────────────────
LEG_D       = 60;
LEG_H       = 70;
LEG_BORE    = 16;    // cable channel Ø

// ── Trunk ────────────────────────────────────────────────────────────
TRUNK_X     = 100;
TRUNK_Y     = 80;
TRUNK_Z     = 140;

// ── Neck stub (enlarged from XML 30³ to fit MG996R + MG90S stacked) ──
NECK_X      = 30;
NECK_Y      = 40;
NECK_Z      = 40;

// ── Head / phone cradle ──────────────────────────────────────────────
// XML head_plate visible face: 200 × 100 mm (landscape), 20 mm thick
// XML head_frame_back: 216 × 26 × 114 mm
HEAD_X      = 216;
HEAD_Y      = 26;
HEAD_Z      = 114;
PHONE_X     = 165;   // typical 6.1" phone outline; iPhone 15-class
PHONE_Y     = 9;     // phone thickness
PHONE_Z     = 76;
BEZEL_LIP   = 6;     // visible-face overlap on the front bezel

// ── Shoulder bracket ─────────────────────────────────────────────────
SHB_X       = 36;
SHB_Y       = 28;
SHB_Z       = 28;

// ── Arm ──────────────────────────────────────────────────────────────
ARM_D       = 26;
ARM_L       = 60;

// ── Servo cavities (datasheet + FIT clearance) ───────────────────────
// DS3218 standard servo body: 40 × 20 × 38.5 + cable boss
DS3218_X = 40.0 + FIT;
DS3218_Y = 20.0 + FIT;
DS3218_Z = 38.5 + FIT;
DS3218_EAR_W = 54.5;   // mounting-ear span
DS3218_EAR_T = 2.5;

// MG996R: 40.7 × 19.7 × 42.9
MG996R_X = 40.7 + FIT;
MG996R_Y = 19.7 + FIT;
MG996R_Z = 42.9 + FIT;

// MG90S / SG90: 22.8 × 12.2 × 28.5 (MG90S body height includes flange)
MG90S_X = 22.8 + FIT;
MG90S_Y = 12.2 + FIT;
MG90S_Z = 28.5 + FIT;
