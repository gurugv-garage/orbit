// Base — upper half (z = BASE_SPLIT .. BASE_H).
// Carries the thrust-bearing seat and the leg-shaft socket.
include <params.scad>
use <util.scad>

THRUST_OD = 14;    // F6-14M outer Ø
THRUST_H  = 5;

module base_upper() {
    H = BASE_H - BASE_SPLIT;
    difference() {
        union() {
            // Outer disc.
            cylinder(h = H, d = BASE_D);
            // Flange (cosmetic + bearing housing) on top.
            translate([0, 0, H])
                cylinder(h = BASE_FLANGE_H, d = BASE_FLANGE_D);
        }

        // Hollow interior (matches lower half).
        translate([0, 0, -0.1])
            cylinder(h = H - WALL + 0.1, d = BASE_D - 2 * WALL);

        // Central through-hole for leg shaft + cables.
        translate([0, 0, -0.1])
            cylinder(h = H + BASE_FLANGE_H + 0.2, d = LEG_BORE);

        // Thrust-bearing seat (Ø14 × 5 mm pocket) inside the flange.
        translate([0, 0, H + BASE_FLANGE_H - THRUST_H])
            cylinder(h = THRUST_H + 0.1, d = THRUST_OD + 0.4);

        // Rim screw holes — boss side.
        for (a = [0 : 60 : 359])
            rotate([0, 0, a])
                translate([BASE_D/2 - 6, 0, -0.1])
                    cylinder(h = 7, d = M3_CLEAR);

        // Alignment-peg holes (2 corners).
        for (a = [0, 180])
            rotate([0, 0, a])
                translate([BASE_D/2 - 12, 0, -0.1])
                    peg_hole(h = 6.2);
    }

    // Insert bosses for the 6 rim screws, on the interior floor.
    for (a = [0 : 60 : 359])
        rotate([0, 0, a])
            translate([BASE_D/2 - 6, 0, 0])
                insert_boss(h = 8);
}

base_upper();
