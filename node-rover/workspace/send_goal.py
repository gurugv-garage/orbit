#!/usr/bin/env python3
"""
Set initial pose for AMCL, then send a NavigateToPose goal. Prints feedback.

Usage:
  send_goal.py [GOAL_X] [GOAL_Y] [GOAL_YAW_DEG]
Defaults: 1.5, 1.0, 0.0
"""
import math
import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from geometry_msgs.msg import PoseWithCovarianceStamped, PoseStamped, Quaternion
from nav2_msgs.action import NavigateToPose


def yaw_to_quat(yaw_rad: float) -> Quaternion:
    q = Quaternion()
    q.z = math.sin(yaw_rad / 2)
    q.w = math.cos(yaw_rad / 2)
    return q


class Goal(Node):
    def __init__(self):
        super().__init__("send_goal")
        self.init_pub = self.create_publisher(PoseWithCovarianceStamped, "/initialpose", 10)
        self.client = ActionClient(self, NavigateToPose, "/navigate_to_pose")

    def set_initial_pose(self, x=0.0, y=0.0, yaw=0.0):
        msg = PoseWithCovarianceStamped()
        msg.header.frame_id = "map"
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.pose.pose.position.x = x
        msg.pose.pose.position.y = y
        msg.pose.pose.orientation = yaw_to_quat(yaw)
        # Diagonal of covariance (x, y, yaw)
        cov = [0.0] * 36
        cov[0] = 0.25; cov[7] = 0.25; cov[35] = 0.07
        msg.pose.covariance = cov
        # Publish a few times to make sure AMCL picks it up
        for _ in range(5):
            self.init_pub.publish(msg)
            time.sleep(0.2)
        print(f"[init] x={x} y={y} yaw={math.degrees(yaw):.1f}° published")

    def send(self, x, y, yaw):
        if not self.client.wait_for_server(timeout_sec=10.0):
            print("ERROR: /navigate_to_pose action server unavailable")
            return False
        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = "map"
        goal.pose.header.stamp = self.get_clock().now().to_msg()
        goal.pose.pose.position.x = x
        goal.pose.pose.position.y = y
        goal.pose.pose.orientation = yaw_to_quat(yaw)
        print(f"[goal] x={x} y={y} yaw={math.degrees(yaw):.1f}°")
        fut = self.client.send_goal_async(goal, feedback_callback=self._fb)
        rclpy.spin_until_future_complete(self, fut, timeout_sec=10.0)
        handle = fut.result()
        if handle is None or not handle.accepted:
            print("ERROR: goal rejected")
            return False
        print("[goal] accepted")
        rf = handle.get_result_async()
        deadline = time.monotonic() + 60.0
        while time.monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.5)
            if rf.done():
                break
        if not rf.done():
            print("TIMEOUT: 60s elapsed")
            return False
        result = rf.result()
        print(f"[goal] status={result.status} result={result.result}")
        return result.status == 4  # STATUS_SUCCEEDED

    def _fb(self, msg):
        f = msg.feedback
        pos = f.current_pose.pose.position
        print(f"  fb: pos=({pos.x:.2f},{pos.y:.2f}) "
              f"dist_remaining={f.distance_remaining:.2f}m "
              f"recoveries={f.number_of_recoveries}")


def main():
    args = sys.argv[1:]
    gx = float(args[0]) if len(args) > 0 else 1.5
    gy = float(args[1]) if len(args) > 1 else 1.0
    gyaw = math.radians(float(args[2])) if len(args) > 2 else 0.0
    rclpy.init()
    n = Goal()
    n.set_initial_pose(0.0, 0.0, 0.0)
    time.sleep(1.0)
    ok = n.send(gx, gy, gyaw)
    print("RESULT:", "SUCCESS" if ok else "FAIL")
    n.destroy_node()
    rclpy.shutdown()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
