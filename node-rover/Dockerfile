# ROS2 Jazzy + linorobot2 + Nav2 + slam_toolbox + foxglove bridge.
# Built for Mac (Docker Desktop) sim/learning use. No USB hardware assumed.
FROM ros:jazzy-ros-base

ARG DEBIAN_FRONTEND=noninteractive

# Core tools + ROS2 packages linorobot2 / Nav2 / SLAM / foxglove need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      git \
      python3-pip \
      python3-colcon-common-extensions \
      python3-rosdep \
      python3-vcstool \
      ros-jazzy-nav2-bringup \
      ros-jazzy-nav2-common \
      ros-jazzy-slam-toolbox \
      ros-jazzy-robot-localization \
      ros-jazzy-foxglove-bridge \
      ros-jazzy-rviz2 \
      ros-jazzy-teleop-twist-keyboard \
      ros-jazzy-teleop-twist-joy \
      ros-jazzy-joint-state-publisher \
      ros-jazzy-xacro \
      ros-jazzy-ros-gz \
      ros-jazzy-twist-mux \
      ros-jazzy-imu-filter-madgwick \
  && rm -rf /var/lib/apt/lists/*

# linorobot2's micro-ROS agent (for real hardware later; harmless in sim).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-jazzy-micro-ros-agent \
  && rm -rf /var/lib/apt/lists/* || true

# Workspace for source-built packages (linorobot2 itself).
WORKDIR /ws
RUN mkdir -p /ws/src

# Sensible env defaults for ROS2 + colcon.
ENV ROS_DOMAIN_ID=0
ENV ROS_LOCALHOST_ONLY=0
ENV LINOROBOT2_BASE=2wd
ENV LINOROBOT2_LASER_SENSOR=ldlidar
ENV LINOROBOT2_DEPTH_SENSOR=oakdlite

# Source ROS + (if built) workspace overlay on shell start.
RUN echo 'source /opt/ros/jazzy/setup.bash' >> /root/.bashrc \
 && echo '[ -f /ws/install/setup.bash ] && source /ws/install/setup.bash' >> /root/.bashrc

EXPOSE 8765

# Default: drop into a shell. Compose overrides with the actual run commands.
CMD ["bash"]
