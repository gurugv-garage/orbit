#!/usr/bin/env python3
"""
Wander node: pick random reachable goals inside the saved map's free space
and send them to Nav2's /navigate_to_pose. Repeat for N goals or N seconds.

Usage:
  wander_node.py [--goals N] [--time SECS] [--max-r METERS]
Defaults: 5 goals, 300s timeout, sample within 3m of robot's current pose.
"""
import argparse, math, random, sys, time

import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy, QoSDurabilityPolicy
from nav2_msgs.action import NavigateToPose
from nav_msgs.msg import Odometry, OccupancyGrid


# Match /map publisher QoS: reliable + transient_local
MAP_QOS = QoSProfile(
    depth=1,
    reliability=QoSReliabilityPolicy.RELIABLE,
    durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
    history=QoSHistoryPolicy.KEEP_LAST,
)


class Wander(Node):
    def __init__(self):
        super().__init__("wander")
        self.client = ActionClient(self, NavigateToPose, "/navigate_to_pose")
        self.odom = None
        self.map = None
        self.create_subscription(Odometry, "/odom", lambda m: setattr(self, "odom", m), 10)
        self.create_subscription(OccupancyGrid, "/map", lambda m: setattr(self, "map", m), MAP_QOS)

    def wait_ready(self, timeout=30.0):
        deadline = time.monotonic() + timeout
        while (self.odom is None or self.map is None) and time.monotonic() < deadline:
            rclpy.spin_once(self, timeout_sec=0.1)
        if self.odom is None: return "no /odom"
        if self.map is None: return "no /map"
        if not self.client.wait_for_server(timeout_sec=20.0):
            return "no /navigate_to_pose action server"
        return None

    def pick_random_goal(self, max_r=3.0):
        """Sample within max_r of current pose, find a free cell."""
        cx = self.odom.pose.pose.position.x
        cy = self.odom.pose.pose.position.y
        m = self.map
        ox, oy = m.info.origin.position.x, m.info.origin.position.y
        res = m.info.resolution
        w, h = m.info.width, m.info.height
        data = m.data  # row-major
        for _ in range(100):
            theta = random.uniform(0, 2*math.pi)
            r = random.uniform(0.5, max_r)
            gx = cx + r * math.cos(theta)
            gy = cy + r * math.sin(theta)
            cell_x = int((gx - ox) / res)
            cell_y = int((gy - oy) / res)
            if 0 <= cell_x < w and 0 <= cell_y < h:
                val = data[cell_y * w + cell_x]
                if val == 0:  # free
                    return gx, gy, theta
        return None

    def send(self, gx, gy, yaw, deadline_s=45.0):
        g = NavigateToPose.Goal()
        g.pose.header.frame_id = "map"
        g.pose.header.stamp = self.get_clock().now().to_msg()
        g.pose.pose.position.x = gx
        g.pose.pose.position.y = gy
        g.pose.pose.orientation.z = math.sin(yaw/2)
        g.pose.pose.orientation.w = math.cos(yaw/2)
        fut = self.client.send_goal_async(g)
        rclpy.spin_until_future_complete(self, fut, timeout_sec=10)
        h = fut.result()
        if h is None or not h.accepted:
            return "rejected"
        rf = h.get_result_async()
        deadline = time.monotonic() + deadline_s
        while time.monotonic() < deadline and not rf.done():
            rclpy.spin_once(self, timeout_sec=0.5)
        if rf.done():
            st = rf.result().status
            return "SUCCESS" if st == 4 else f"status={st}"
        # Cancel if timeout
        cf = h.cancel_goal_async()
        rclpy.spin_until_future_complete(self, cf, timeout_sec=2)
        return "timeout"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--goals", type=int, default=5)
    p.add_argument("--time", type=float, default=300.0)
    p.add_argument("--max-r", type=float, default=3.0)
    args = p.parse_args()

    rclpy.init()
    n = Wander()
    err = n.wait_ready()
    if err:
        print(f"ERROR: {err}")
        n.destroy_node(); rclpy.shutdown(); sys.exit(1)

    start = time.monotonic()
    completed = 0
    for i in range(args.goals):
        if time.monotonic() - start > args.time:
            print(f"[wander] time limit ({args.time}s) reached")
            break
        sample = n.pick_random_goal(max_r=args.max_r)
        if sample is None:
            print(f"[wander] {i+1}/{args.goals}: couldn't sample a free cell, skipping")
            continue
        gx, gy, yaw = sample
        cx = n.odom.pose.pose.position.x
        cy = n.odom.pose.pose.position.y
        d = math.hypot(gx-cx, gy-cy)
        print(f"[wander] {i+1}/{args.goals}: from ({cx:.2f},{cy:.2f}) "
              f"to ({gx:.2f},{gy:.2f}) dist={d:.2f}m ...")
        res = n.send(gx, gy, yaw)
        print(f"           -> {res}")
        if res == "SUCCESS":
            completed += 1

    print(f"[wander] done: {completed}/{args.goals} succeeded")
    n.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
