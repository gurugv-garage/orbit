// Head — front bezel. Thin plate with a window over the phone screen
// and a retaining lip around the phone outline.
include <params.scad>
use <util.scad>

BEZEL_T = 4;     // total bezel thickness
WIN_X   = PHONE_X - 2 * BEZEL_LIP;
WIN_Z   = PHONE_Z - 2 * BEZEL_LIP;

module head_front() {
    difference() {
        translate([-HEAD_X/2, 0, -HEAD_Z/2])
            cube([HEAD_X, BEZEL_T, HEAD_Z]);

        // Screen window.
        translate([-WIN_X/2, -0.1, -WIN_Z/2])
            cube([WIN_X, BEZEL_T + 0.2, WIN_Z]);

        // 4 corner M3 clearance.
        for (sx = [-1, 1], sz = [-1, 1])
            translate([sx * (HEAD_X/2 - 6), 0, sz * (HEAD_Z/2 - 6)])
                rotate([-90, 0, 0])
                    cylinder(h = BEZEL_T + 1, d = M3_CLEAR);
    }
}

head_front();
