#!/usr/bin/env python3
"""Publish /initialpose using the bot's current /odom pose."""
import math, time
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PoseWithCovarianceStamped
from nav_msgs.msg import Odometry


class Init(Node):
    def __init__(self):
        super().__init__("init_amcl")
        self.pub = self.create_publisher(PoseWithCovarianceStamped, "/initialpose", 10)
        self.odom = None
        self.create_subscription(Odometry, "/odom", lambda m: setattr(self, "odom", m), 10)

    def run(self):
        t0 = time.monotonic()
        while self.odom is None and time.monotonic() - t0 < 5:
            rclpy.spin_once(self, timeout_sec=0.1)
        if self.odom is None:
            print("no /odom"); return False
        p = self.odom.pose.pose
        msg = PoseWithCovarianceStamped()
        msg.header.frame_id = "map"
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.pose.pose = p
        cov = [0.0]*36
        cov[0] = 0.25; cov[7] = 0.25; cov[35] = 0.07
        msg.pose.covariance = cov
        for _ in range(8):
            self.pub.publish(msg)
            time.sleep(0.2)
        print(f"published /initialpose: x={p.position.x:.2f} y={p.position.y:.2f}")
        return True


def main():
    rclpy.init()
    n = Init()
    n.run()
    n.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
