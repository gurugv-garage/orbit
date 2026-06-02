// Trunk — back shell. Split at the XZ plane (y = 0).
// Carries internal standoffs for ESP32, PCA9685, buck converter.
include <params.scad>
use <util.scad>

module trunk_back() {
    difference() {
        // Outer half-shell.
        translate([-TRUNK_X/2, -TRUNK_Y/2, 0])
            cube([TRUNK_X, TRUNK_Y/2, TRUNK_Z]);
        // Hollow interior.
        translate([-TRUNK_X/2 + WALL, -TRUNK_Y/2 + WALL, WALL])
            cube([TRUNK_X - 2 * WALL,
                  TRUNK_Y/2 - WALL + 0.1,
                  TRUNK_Z - 2 * WALL]);

        // Leg-shaft mounting pattern on the floor (4× M3 clearance).
        for (a = [0 : 90 : 359])
            rotate([0, 0, a])
                translate([LEG_D/2 - 5, 0, -0.1])
                    cylinder(h = WALL + 0.2, d = M3_CLEAR);
        // Central cable pass-through.
        translate([0, 0, -0.1])
            cylinder(h = WALL + 0.2, d = LEG_BORE);

        // Neck-stub mounting pattern on the ceiling (4× M3 clearance).
        for (dx = [-10, 10], dy = [-10, 10])
            translate([dx, dy, TRUNK_Z - WALL - 0.1])
                cylinder(h = WALL + 0.2, d = M3_CLEAR);

        // Shoulder bracket cutouts on left/right walls (38 × 30 each side).
        for (sx = [-1, 1])
            translate([sx * (TRUNK_X/2 - WALL - 0.1),
                       -38/2,
                       TRUNK_Z/2 - 30/2])
                cube([WALL + 0.2, 38, 30]);
    }

    // Internal standoffs for ESP32 (4× at 26×48 spacing).
    for (dx = [-26/2, 26/2], dy = [-48/2, 48/2])
        translate([dx, -TRUNK_Y/2 + WALL + dy + TRUNK_Y/4, WALL])
            insert_boss(h = 6);

    // Rim insert bosses for joining front shell (8 around).
    for (z = [10, TRUNK_Z - 10])
        for (sx = [-1, 1])
            translate([sx * (TRUNK_X/2 - 5), 0, z])
                rotate([90, 0, 0]) insert_boss(h = 6);

    // Alignment pegs at 2 corners.
    for (sx = [-1, 1])
        translate([sx * (TRUNK_X/2 - 5), 0, TRUNK_Z/2])
            rotate([90, 0, 0]) peg(h = 6);
}

trunk_back();
