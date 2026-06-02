// Trunk — front shell. Mirror of trunk_back, no internal mounts.
include <params.scad>
use <util.scad>

module trunk_front() {
    difference() {
        translate([-TRUNK_X/2, 0, 0])
            cube([TRUNK_X, TRUNK_Y/2, TRUNK_Z]);
        // Hollow.
        translate([-TRUNK_X/2 + WALL, -0.1, WALL])
            cube([TRUNK_X - 2 * WALL,
                  TRUNK_Y/2 - WALL + 0.1,
                  TRUNK_Z - 2 * WALL]);

        // Rim clearance holes for the back-shell inserts.
        for (z = [10, TRUNK_Z - 10])
            for (sx = [-1, 1])
                translate([sx * (TRUNK_X/2 - 5), 0, z])
                    rotate([-90, 0, 0])
                        cylinder(h = WALL + 1, d = M3_CLEAR);

        // Alignment-peg holes.
        for (sx = [-1, 1])
            translate([sx * (TRUNK_X/2 - 5), 0, TRUNK_Z/2])
                rotate([-90, 0, 0]) peg_hole(h = 6.2);
    }
}

trunk_front();
