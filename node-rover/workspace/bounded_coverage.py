#!/usr/bin/env python3
"""
Drive in a bounded square pattern for SLAM coverage. Stays within a ~3m
radius of start. Combines forward driving with periodic turns to ensure
the robot doesn't wander too far from where SLAM started.
"""
import math, time, sys
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry


LIN = 0.18
ANG = 0.8
SAFE_FRONT = 0.5
MAX_R = 2.5  # max radius from start
FRONT_HALF_DEG = 25


class BoundedDriver(Node):
    def __init__(self):
        super().__init__("bounded_drv")
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.scan = None
        self.odom = None
        self.start = None
        self.create_subscription(LaserScan, "/scan", lambda m: setattr(self, "scan", m), 10)
        self.create_subscription(Odometry, "/odom", self._odom, 10)

    def _odom(self, m):
        self.odom = m
        if self.start is None:
            self.start = (m.pose.pose.position.x, m.pose.pose.position.y)

    def front_clear(self):
        if self.scan is None: return None
        s = self.scan
        min_r = float("inf")
        for i, r in enumerate(s.ranges):
            a = s.angle_min + i * s.angle_increment
            a = math.atan2(math.sin(a), math.cos(a))
            if abs(a) <= math.radians(FRONT_HALF_DEG) and math.isfinite(r) and r > 0.05:
                min_r = min(min_r, r)
        return min_r

    def dist_from_start(self):
        if self.odom is None or self.start is None: return 0
        dx = self.odom.pose.pose.position.x - self.start[0]
        dy = self.odom.pose.pose.position.y - self.start[1]
        return math.hypot(dx, dy)

    def step(self):
        c = self.front_clear()
        d = self.dist_from_start()
        t = Twist()
        if c is None: return
        if d > MAX_R:
            # turn around — face toward start
            sx, sy = self.start
            cx, cy = self.odom.pose.pose.position.x, self.odom.pose.pose.position.y
            yaw_to_start = math.atan2(sy - cy, sx - cx)
            # get current yaw
            q = self.odom.pose.pose.orientation
            cur_yaw = math.atan2(2*(q.w*q.z + q.x*q.y), 1 - 2*(q.y*q.y + q.z*q.z))
            err = math.atan2(math.sin(yaw_to_start - cur_yaw), math.cos(yaw_to_start - cur_yaw))
            if abs(err) > math.radians(15):
                t.angular.z = ANG if err > 0 else -ANG
            else:
                t.linear.x = LIN
        elif c < SAFE_FRONT:
            import random
            t.angular.z = ANG * random.choice([-1, 1])
        else:
            t.linear.x = LIN
        self.pub.publish(t)


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 120.0
    rclpy.init()
    n = BoundedDriver()
    t0 = time.monotonic()
    while (n.scan is None or n.odom is None) and time.monotonic() - t0 < 5:
        rclpy.spin_once(n, timeout_sec=0.1)
    print(f"[bounded] driving {duration}s (max radius {MAX_R}m from start)")
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        t1 = time.monotonic()
        n.step()
        rclpy.spin_once(n, timeout_sec=0.02)
        dt = time.monotonic() - t1
        if dt < 0.1: time.sleep(0.1 - dt)
    for _ in range(5): n.pub.publish(Twist()); time.sleep(0.05)
    # Drive back near start
    print("[bounded] returning toward start")
    return_deadline = time.monotonic() + 30
    while time.monotonic() < return_deadline and n.dist_from_start() > 0.3:
        sx, sy = n.start
        cx, cy = n.odom.pose.pose.position.x, n.odom.pose.pose.position.y
        yaw_to_start = math.atan2(sy - cy, sx - cx)
        q = n.odom.pose.pose.orientation
        cur_yaw = math.atan2(2*(q.w*q.z + q.x*q.y), 1 - 2*(q.y*q.y + q.z*q.z))
        err = math.atan2(math.sin(yaw_to_start - cur_yaw), math.cos(yaw_to_start - cur_yaw))
        t = Twist()
        if abs(err) > math.radians(10):
            t.angular.z = ANG if err > 0 else -ANG
        else:
            t.linear.x = LIN
        n.pub.publish(t)
        rclpy.spin_once(n, timeout_sec=0.05)
    for _ in range(5): n.pub.publish(Twist()); time.sleep(0.05)
    print(f"[bounded] done. final dist from start: {n.dist_from_start():.2f}m")
    n.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
