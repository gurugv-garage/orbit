// Head — back tray. Phone cradle; carries the MG90S roll horn coupler.
// Phone slots in from the front; bezel screws on to retain it.
include <params.scad>
use <util.scad>

module head_back() {
    difference() {
        translate([-HEAD_X/2, -HEAD_Y/2, -HEAD_Z/2])
            cube([HEAD_X, HEAD_Y, HEAD_Z]);

        // Phone slot — open toward +Y (toward bezel).
        translate([0, HEAD_Y/2 - PHONE_Y - WALL,  0])
            translate([-(PHONE_X + PHONE_FIT)/2, 0,
                       -(PHONE_Z + PHONE_FIT)/2])
                cube([PHONE_X + PHONE_FIT,
                      PHONE_Y + PHONE_FIT + WALL + 0.1,
                      PHONE_Z + PHONE_FIT]);

        // Speaker/charge cutout at the bottom of the phone slot.
        translate([0, HEAD_Y/2 - PHONE_Y/2, -HEAD_Z/2 - 0.1])
            cube([60, PHONE_Y + 1, 8 + 0.2], center = true);

        // 4 corner M3 clearance holes (front bezel screws in).
        for (sx = [-1, 1], sz = [-1, 1])
            translate([sx * (HEAD_X/2 - 6), 0, sz * (HEAD_Z/2 - 6)])
                rotate([-90, 0, 0])
                    cylinder(h = HEAD_Y + 1, d = M3_CLEAR);

        // Roll-servo horn mount on the back face (Ø25 horn pocket + 4 screws).
        translate([0, -HEAD_Y/2 + 0.1, 0])
            rotate([-90, 0, 0])
                cylinder(h = 6, d = 25 + 0.4);
        for (a = [0 : 90 : 359])
            rotate([0, 0, a])
                translate([7, -HEAD_Y/2 - 0.1, 0])
                    rotate([-90, 0, 0])
                        cylinder(h = 8, d = 2.5);
    }
}

head_back();
