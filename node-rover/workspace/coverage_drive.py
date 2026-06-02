#!/usr/bin/env python3
"""
Drive a coverage pattern for SLAM mapping. Wander with reactive wall-avoid
based on /scan. Run for N seconds (default 90) then stop. Use to build a
slam_toolbox map of turtlebot3_world.
"""
import math
import random
import sys
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from sensor_msgs.msg import LaserScan


LIN = 0.18         # m/s forward
ANG = 0.8          # rad/s turn
SAFE_FRONT = 0.45  # meters; turn when nearer than this
FRONT_HALF_DEG = 25  # half-cone for "front"


class Coverage(Node):
    def __init__(self):
        super().__init__("coverage_drive")
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.scan = None
        self.create_subscription(LaserScan, "/scan", self._scan, 10)

    def _scan(self, msg):
        self.scan = msg

    def front_clearance(self):
        if self.scan is None:
            return None
        s = self.scan
        n = len(s.ranges)
        # Front is index 0 (angle_min ≈ -pi or 0 depending on driver). LD06 usually 0 = front.
        # Use a window around angle 0 in the scan's frame.
        # Build a small set of valid range readings within ±FRONT_HALF_DEG of angle 0.
        idxs = []
        for i, r in enumerate(s.ranges):
            ang = s.angle_min + i * s.angle_increment
            # normalize ang to (-pi, pi]
            a = math.atan2(math.sin(ang), math.cos(ang))
            if abs(a) <= math.radians(FRONT_HALF_DEG):
                if math.isfinite(r) and r > 0.05:
                    idxs.append(r)
        return min(idxs) if idxs else float("inf")

    def step(self):
        c = self.front_clearance()
        t = Twist()
        if c is None:
            return
        if c < SAFE_FRONT:
            # Turn (random direction, biased toward longer turns)
            t.angular.z = ANG * random.choice([-1, 1])
        else:
            t.linear.x = LIN
            # Small bias to keep exploring
            if random.random() < 0.05:
                t.angular.z = ANG * 0.3 * random.choice([-1, 1])
        self.pub.publish(t)


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0
    rclpy.init()
    n = Coverage()
    # Wait for scan
    t0 = time.monotonic()
    while n.scan is None and time.monotonic() - t0 < 5:
        rclpy.spin_once(n, timeout_sec=0.1)
    if n.scan is None:
        print("ERROR: no /scan received")
        sys.exit(1)
    print(f"[coverage] driving for {duration:.0f}s")
    deadline = time.monotonic() + duration
    rate_hz = 10
    period = 1.0 / rate_hz
    while time.monotonic() < deadline:
        t1 = time.monotonic()
        n.step()
        rclpy.spin_once(n, timeout_sec=0.01)
        dt = time.monotonic() - t1
        if dt < period:
            time.sleep(period - dt)
    # Stop
    for _ in range(5):
        n.pub.publish(Twist())
        time.sleep(0.05)
    print("[coverage] done")
    n.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
