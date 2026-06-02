#!/usr/bin/env python3
"""
Drive a 1m x 1m square via /cmd_vel and measure odometry closure error.

Steps: forward 1m, turn 90°, repeat 4 times. End pose should equal start
pose. Reports Euclidean and angular drift.

Sim-only sanity check: in Gazebo with the linorobot2 diff-drive plugin,
closure error should be < 5 cm and < 5°. Larger errors indicate sim
config issues (TF tree, plugin params, etc.) — not real-world calibration.
"""
import math
import sys
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry


LIN_SPEED = 0.15  # m/s
ANG_SPEED = 0.5   # rad/s
SIDE_M = 1.0
TURN_RAD = math.pi / 2


def yaw_from_quat(q) -> float:
    siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
    cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
    return math.atan2(siny_cosp, cosy_cosp)


class SquareDriver(Node):
    def __init__(self):
        super().__init__("square_driver")
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.sub = self.create_subscription(Odometry, "/odom", self._odom_cb, 10)
        self.odom = None

    def _odom_cb(self, msg: Odometry):
        self.odom = msg

    def wait_for_odom(self, timeout: float = 5.0):
        deadline = time.monotonic() + timeout
        while self.odom is None and time.monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.1)
        if self.odom is None:
            raise RuntimeError("no /odom received")

    def stop(self):
        for _ in range(5):
            self.pub.publish(Twist())
            time.sleep(0.05)

    def drive_for(self, vx: float, wz: float, duration: float):
        cmd = Twist()
        cmd.linear.x = vx
        cmd.angular.z = wz
        end = time.monotonic() + duration
        while time.monotonic() < end:
            self.pub.publish(cmd)
            rclpy.spin_once(self, timeout_sec=0.05)
        self.stop()


def main():
    rclpy.init()
    n = SquareDriver()
    try:
        n.wait_for_odom()
        time.sleep(0.5)
        start = n.odom.pose.pose
        sx, sy = start.position.x, start.position.y
        syaw = yaw_from_quat(start.orientation)
        print(f"[start] x={sx:.3f} y={sy:.3f} yaw={math.degrees(syaw):.2f}°")

        fwd_t = SIDE_M / LIN_SPEED
        turn_t = TURN_RAD / ANG_SPEED

        for leg in range(4):
            n.drive_for(LIN_SPEED, 0.0, fwd_t)
            time.sleep(0.3)
            n.drive_for(0.0, ANG_SPEED, turn_t)
            time.sleep(0.3)
            x = n.odom.pose.pose.position.x
            y = n.odom.pose.pose.position.y
            yaw = yaw_from_quat(n.odom.pose.pose.orientation)
            print(f"[leg {leg+1}/4] x={x:.3f} y={y:.3f} yaw={math.degrees(yaw):.2f}°")

        end = n.odom.pose.pose
        ex, ey = end.position.x, end.position.y
        eyaw = yaw_from_quat(end.orientation)
        dx, dy = ex - sx, ey - sy
        closure = math.hypot(dx, dy)
        yaw_drift = math.degrees(eyaw - syaw)
        # normalize yaw_drift to (-180, 180]
        while yaw_drift > 180: yaw_drift -= 360
        while yaw_drift <= -180: yaw_drift += 360

        print(f"[end]   x={ex:.3f} y={ey:.3f} yaw={math.degrees(eyaw):.2f}°")
        print(f"[drift] dx={dx:.3f} dy={dy:.3f} closure={closure*100:.1f} cm  yaw_drift={yaw_drift:.2f}°")

        # exit 0 if sim closure error < 30 cm (sim is usually < 10 cm)
        sys.exit(0 if closure < 0.30 else 1)
    finally:
        n.stop()
        n.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
