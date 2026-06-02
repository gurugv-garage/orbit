// Leg shaft — hollow tube between base and trunk.
// Couples DS3218 horn at bottom, bolts into trunk back-shell floor at top.
include <params.scad>
use <util.scad>

HORN_BOSS_H = 6;
HORN_D      = 25;   // 25T servo horn outer Ø

module leg_shaft() {
    difference() {
        cylinder(h = LEG_H, d = LEG_D);

        // Cable channel.
        translate([0, 0, -0.1])
            cylinder(h = LEG_H + 0.2, d = LEG_BORE);

        // Servo-horn pocket at bottom (Ø25 × 6 mm) + 4 horn screw holes.
        translate([0, 0, -0.1])
            cylinder(h = HORN_BOSS_H + 0.1, d = HORN_D + 0.4);
        for (a = [0 : 90 : 359])
            rotate([0, 0, a])
                translate([7, 0, -0.1])
                    cylinder(h = HORN_BOSS_H + 0.1, d = 2.5);

        // 4 M3 clearance holes near the top, for bolting to trunk floor.
        for (a = [0 : 90 : 359])
            rotate([0, 0, a])
                translate([LEG_D/2 - 5, 0, LEG_H - 8])
                    rotate([0, 90, 0])
                        cylinder(h = 6, d = M3_CLEAR);
    }
}

leg_shaft();
