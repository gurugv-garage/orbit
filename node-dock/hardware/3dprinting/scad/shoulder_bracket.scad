// Shoulder bracket — houses SG90, bolts into trunk side wall.
// Print 2 (mirrored is identical because the SG90 cavity is symmetric).
include <params.scad>
use <util.scad>

module shoulder_bracket() {
    difference() {
        translate([-SHB_X/2, -SHB_Y/2, 0])
            cube([SHB_X, SHB_Y, SHB_Z]);

        // SG90 cavity (oriented with shaft pointing +X out the side).
        translate([0, 0, WALL])
            servo_cavity(MG90S_X, MG90S_Y, MG90S_Z);

        // Output-shaft access on the +X face.
        translate([SHB_X/2 - WALL - 0.1, 0, WALL + MG90S_Z - 5])
            rotate([0, 90, 0]) cylinder(h = WALL + 0.4, d = 8);

        // 4 M3 clearance holes for bolting to trunk side wall.
        for (dx = [-12, 12], dz = [6, SHB_Z - 6])
            translate([dx, -SHB_Y/2 - 0.1, dz])
                rotate([-90, 0, 0])
                    cylinder(h = SHB_Y + 0.2, d = M3_CLEAR);
    }
}

shoulder_bracket();
