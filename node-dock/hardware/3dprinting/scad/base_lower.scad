// Base — lower half (z = 0 .. BASE_SPLIT).
// Houses DS3218 yaw servo, 12V jack, PCA9685-side wiring.
include <params.scad>
use <util.scad>

module base_lower() {
    difference() {
        // Outer disc, lower half.
        cylinder(h = BASE_SPLIT, d = BASE_D);

        // Hollow interior, leaving WALL on sides and floor.
        translate([0, 0, WALL])
            cylinder(h = BASE_SPLIT, d = BASE_D - 2 * WALL);

        // DS3218 servo cavity (shaft up, sits on the floor).
        translate([0, 0, WALL])
            servo_cavity(DS3218_X, DS3218_Y, DS3218_Z);

        // Servo output-shaft access hole (Ø10).
        translate([0, 0, -0.1]) cylinder(h = WALL + 0.2, d = 10);

        // 12V barrel-jack hole on the rim (Ø11, at +X side).
        translate([BASE_D/2 - WALL - 0.1, 0, BASE_SPLIT/2])
            rotate([0, 90, 0]) cylinder(h = WALL + 0.4, d = 11);

        // Rim screw holes for joining upper/lower halves (6 around).
        for (a = [0 : 60 : 359])
            rotate([0, 0, a])
                translate([BASE_D/2 - 6, 0, BASE_SPLIT - 6])
                    cylinder(h = 7, d = M3_CLEAR);
    }

    // Insert bosses underneath the rim screw holes, in the upper half.
    // (Bosses live in the *upper* half — see base_upper.scad.)

    // Alignment pegs sticking up at 2 corners (0° and 180°).
    for (a = [0, 180])
        rotate([0, 0, a])
            translate([BASE_D/2 - 12, 0, BASE_SPLIT])
                peg(h = 6);
}

base_lower();
