// Shared helper modules for node-dock parts.
include <params.scad>

// Boss for a heat-set insert. h = total boss height, with insert pocket
// drilled from the top.
module insert_boss(h = 8) {
    difference() {
        cylinder(h = h, d = M3_INSERT_D + 2 * WALL);
        translate([0, 0, h - M3_INSERT_H])
            cylinder(h = M3_INSERT_H + 0.1, d = M3_INSERT_D);
    }
}

// Through-hole for M3 clearance.
module m3_through(h) {
    cylinder(h = h + 0.2, d = M3_CLEAR, center = false);
}

// Alignment peg (printed solid).
module peg(h = 8) {
    cylinder(h = h, d = PEG_D);
}

// Alignment-peg socket.
module peg_hole(h = 8) {
    cylinder(h = h + 0.1, d = PEG_D + 0.2);
}

// Rounded rectangle (2D) for shells.
module rrect(x, y, r = 3) {
    hull() for (sx = [-1, 1], sy = [-1, 1])
        translate([sx * (x/2 - r), sy * (y/2 - r), 0]) circle(r = r);
}

// Servo cavity (rectangular box, centered XY, base at z=0).
module servo_cavity(x, y, z) {
    translate([-x/2, -y/2, 0]) cube([x, y, z + 0.1]);
}
