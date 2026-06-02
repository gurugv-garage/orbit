// Neck stub — houses stacked MG996R (pitch) + MG90S (roll).
// Bolts to trunk_back ceiling; top face carries the head cradle.
include <params.scad>
use <util.scad>

module neck_stub() {
    difference() {
        translate([-NECK_X/2, -NECK_Y/2, 0])
            cube([NECK_X, NECK_Y, NECK_Z]);

        // MG996R cavity (pitch, axis X) — lower position.
        translate([0, 0, WALL])
            servo_cavity(MG996R_Y, MG996R_X, MG996R_Z);
        // MG996R output-shaft access (pitch axis runs through X side).
        translate([NECK_X/2 - WALL - 0.1, 0, WALL + MG996R_Z/2])
            rotate([0, 90, 0]) cylinder(h = WALL + 0.4, d = 8);

        // MG90S cavity (roll, axis Y) — stacked above.
        translate([0, 0, WALL + MG996R_Z + 2])
            servo_cavity(MG90S_X, MG90S_Y, MG90S_Z);
        // MG90S output-shaft access through top face.
        translate([0, 0, NECK_Z - WALL - 0.1])
            cylinder(h = WALL + 0.4, d = 8);

        // Mounting holes on the bottom face (matches trunk_back ceiling pattern).
        for (dx = [-10, 10], dy = [-10, 10])
            translate([dx, dy, -0.1])
                cylinder(h = WALL + 0.2, d = M3_CLEAR);

        // Cable pass-through to trunk.
        translate([0, NECK_Y/2 - WALL - 5, -0.1])
            cylinder(h = WALL + 0.2, d = 8);
    }
}

neck_stub();
