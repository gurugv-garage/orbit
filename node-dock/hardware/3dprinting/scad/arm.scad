// Arm — decorative limb. Capsule body, 25T horn pocket at the pivot end.
include <params.scad>
use <util.scad>

module arm() {
    HORN_BOSS_H = 6;
    union() {
        difference() {
            // Capsule = cylinder + hemispheres.
            union() {
                cylinder(h = ARM_L, d = ARM_D);
                translate([0, 0, ARM_L]) sphere(d = ARM_D);
                sphere(d = ARM_D);
            }
            // Horn pocket + screw at the pivot end.
            translate([0, 0, -0.1])
                cylinder(h = HORN_BOSS_H + 0.1, d = 25 + 0.4);
            translate([0, 0, -ARM_D/2])
                cylinder(h = HORN_BOSS_H + ARM_D/2 + 1, d = 4);
        }
    }
}

arm();
