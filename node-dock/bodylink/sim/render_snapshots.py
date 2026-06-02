"""Render snapshots of the MuJoCo body from multiple angles and poses.

Run: python3 render_snapshots.py

Produces PNGs under sim/snapshots/ so you can eyeball the geometry without
needing an interactive viewer.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import mujoco
import numpy as np

HERE = Path(__file__).parent
MODEL_PATH = HERE / "bodies" / "dock_humanoid.xml"
OUT_DIR = HERE / "snapshots"


def render(model, data, cam_pos, cam_lookat, width=900, height=900):
    cam = mujoco.MjvCamera()
    cam.lookat[:] = cam_lookat
    cam.distance = float(np.linalg.norm(np.array(cam_pos) - np.array(cam_lookat)))
    # azimuth/elevation derived from cam_pos relative to lookat:
    dx, dy, dz = (np.array(cam_pos) - np.array(cam_lookat))
    cam.azimuth = float(np.degrees(np.arctan2(dy, dx)))
    cam.elevation = float(np.degrees(np.arctan2(dz, np.hypot(dx, dy))))

    renderer = mujoco.Renderer(model, height=height, width=width)
    mujoco.mj_forward(model, data)
    renderer.update_scene(data, camera=cam)
    return renderer.render()


def save_png(arr, path):
    # Avoid pulling in PIL; use matplotlib's imsave or write a minimal PPM.
    try:
        import imageio.v3 as iio  # type: ignore
        iio.imwrite(str(path), arr)
        return
    except ImportError:
        pass
    try:
        from PIL import Image  # type: ignore
        Image.fromarray(arr).save(str(path))
        return
    except ImportError:
        pass
    # Fallback: matplotlib
    import matplotlib.pyplot as plt
    plt.imsave(str(path), arr)


def set_pose(data, name_to_qpos: dict[str, float], model):
    for jname, val in name_to_qpos.items():
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, jname)
        if jid < 0:
            raise KeyError(f"unknown joint: {jname}")
        qadr = model.jnt_qposadr[jid]
        data.qpos[qadr] = val


POSES = {
    "neutral":        {},
    "look_up":        {"neck_pitch": -0.4},
    "look_down":      {"neck_pitch":  0.4},
    "swivel_left":    {"foot_yaw":    0.8},
    "swivel_right":   {"foot_yaw":   -0.8},
    "raise_left_arm": {"shoulder_left_pitch":  -1.55},
    # Lateral abduction: left raises to negative, right raises to positive.
    "wave_both":      {"shoulder_left_pitch":  -1.20, "shoulder_right_pitch": 1.20},
}

# View angles tuned for a small (~30 cm) desk companion.
VIEWS = [
    ((0.80, -0.80, 0.55), (0, 0, 0.20), "iso"),
    ((0.95,  0.00, 0.30), (0, 0, 0.20), "side"),
    ((0.00, -0.95, 0.30), (0, 0, 0.20), "front"),
]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not MODEL_PATH.exists():
        sys.exit(f"missing model: {MODEL_PATH}")

    model = mujoco.MjModel.from_xml_path(str(MODEL_PATH))
    data = mujoco.MjData(model)

    written = []
    for pose_name, qpos in POSES.items():
        # Reset and apply pose.
        mujoco.mj_resetData(model, data)
        set_pose(data, qpos, model)
        for cam_pos, lookat, view in VIEWS:
            arr = render(model, data, cam_pos, lookat)
            out = OUT_DIR / f"{pose_name}_{view}.png"
            save_png(arr, out)
            written.append(str(out.relative_to(HERE)))

    print(f"wrote {len(written)} images to {OUT_DIR}")
    for p in written:
        print(" ", p)


if __name__ == "__main__":
    main()
