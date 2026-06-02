"""Test every named state in a BodyProfile against the MuJoCo model.

Loads the profile + the model, then for each (part, state) combination:
  - Resets the model
  - Applies the joint targets declared by that state
  - Steps the sim long enough for actuators to converge
  - Renders a screenshot from front/side/iso

Output: snapshots/states/<part>__<state>__<view>.png

This is the CLI sign-off that says "every state in the profile actually maps
to a sane visual." The WS server layered on top later just sends these same
commands over the wire — no surprises.

Usage:
    python3 test_profile.py
    python3 test_profile.py --profile profiles/dock_companion.json --model bodies/dock_humanoid.xml
    python3 test_profile.py --only head            # filter by part
    python3 test_profile.py --only head.lookUp     # filter by state
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import mujoco
import numpy as np

HERE = Path(__file__).parent


def render(model, data, cam_pos, cam_lookat, width=900, height=900):
    cam = mujoco.MjvCamera()
    cam.lookat[:] = cam_lookat
    cam.distance = float(np.linalg.norm(np.array(cam_pos) - np.array(cam_lookat)))
    dx, dy, dz = (np.array(cam_pos) - np.array(cam_lookat))
    cam.azimuth = float(np.degrees(np.arctan2(dy, dx)))
    cam.elevation = float(np.degrees(np.arctan2(dz, np.hypot(dx, dy))))

    renderer = mujoco.Renderer(model, height=height, width=width)
    mujoco.mj_forward(model, data)
    renderer.update_scene(data, camera=cam)
    return renderer.render()


def save_png(arr, path: Path):
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
    import matplotlib.pyplot as plt  # type: ignore
    plt.imsave(str(path), arr)


VIEWS = [
    ((0.80, -0.80, 0.55), (0, 0, 0.20), "iso"),
    ((0.95,  0.00, 0.30), (0, 0, 0.20), "side"),
    ((0.00, -0.95, 0.30), (0, 0, 0.20), "front"),
]


def apply_state(model, data, joints: dict[str, float]) -> None:
    """Set the actuator ctrl values for every named joint in `joints`.

    The MJCF declares actuators named `a_<joint>`. We look those up and
    write the target angles. After this, mj_step advances the position
    actuators until they converge.
    """
    for joint_name, target in joints.items():
        act_name = f"a_{joint_name}"
        act_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, act_name)
        if act_id < 0:
            raise KeyError(f"unknown actuator: {act_name} (for joint {joint_name})")
        data.ctrl[act_id] = float(target)


def settle(model, data, seconds: float = 1.5) -> None:
    """Step the sim until actuators have converged on their targets."""
    n_steps = int(seconds / model.opt.timestep)
    for _ in range(n_steps):
        mujoco.mj_step(model, data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--profile", default=str(HERE / "profiles" / "dock_companion.json"))
    ap.add_argument("--model",   default=str(HERE / "bodies"   / "dock_humanoid.xml"))
    ap.add_argument("--out",     default=str(HERE / "snapshots" / "states"))
    ap.add_argument(
        "--only",
        default=None,
        help="Filter by part name (e.g. 'head', 'arm.left') or part.state ('head.lookUp', 'arm.left.wave').",
    )
    ap.add_argument(
        "--views",
        default="front",
        help="Comma-separated views to render: front,side,iso. Default: front.",
    )
    args = ap.parse_args()

    profile_path = Path(args.profile)
    model_path = Path(args.model)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not profile_path.exists():
        print(f"error: profile not found: {profile_path}", file=sys.stderr)
        return 2
    if not model_path.exists():
        print(f"error: model not found: {model_path}", file=sys.stderr)
        return 2

    with profile_path.open() as f:
        profile = json.load(f)

    model = mujoco.MjModel.from_xml_path(str(model_path))
    data = mujoco.MjData(model)

    selected_views = [v.strip() for v in args.views.split(",") if v.strip()]
    views = [v for v in VIEWS if v[2] in selected_views]
    if not views:
        print(f"error: no views matched {args.views}", file=sys.stderr)
        return 2

    # Filter (part, state) combos.
    # The `--only` value can be:
    #   * a part name (which may itself contain dots, e.g. "arm.left")
    #   * a "<part>.<state>" reference (e.g. "head.lookUp", "arm.left.wave")
    # Disambiguate by checking the part list before splitting.
    part_names = list(profile.get("parts", {}).keys())
    filter_part: str | None = None
    filter_state: str | None = None
    if args.only:
        if args.only in part_names:
            filter_part = args.only
        else:
            # Find the longest part-prefix that matches.
            matched = next(
                (p for p in sorted(part_names, key=len, reverse=True)
                 if args.only.startswith(p + ".")),
                None,
            )
            if matched:
                filter_part = matched
                filter_state = args.only[len(matched) + 1:]
            else:
                filter_part = args.only  # let it match nothing if invalid

    print(f"profile: {profile_path.name}  device_id={profile.get('device_id')}")
    print(f"model:   {model_path.name}")
    print(f"views:   {[v[2] for v in views]}")
    print(f"output:  {out_dir}")
    print()

    parts = profile.get("parts", {})
    total = 0
    written: list[str] = []
    failures: list[tuple[str, str, str]] = []

    for part_name, part_spec in parts.items():
        if filter_part and part_name != filter_part:
            continue
        states = part_spec.get("states", {})
        for state_name, state_spec in states.items():
            if filter_state and state_name != filter_state:
                continue
            joints = state_spec.get("joints", {})
            description = state_spec.get("description", "")
            duration_ms = state_spec.get("duration_ms", "?")

            total += 1
            print(f"[{part_name:10s}] {state_name:10s}  {duration_ms}ms  — {description}")

            try:
                mujoco.mj_resetData(model, data)
                # Apply *all* parts' default_state first, so unrelated joints
                # are in a known, neutral position. Then overlay the state
                # under test.
                for p_name, p_spec in parts.items():
                    default = p_spec.get("default_state")
                    if default and default in p_spec.get("states", {}):
                        apply_state(model, data, p_spec["states"][default].get("joints", {}))
                apply_state(model, data, joints)
                settle(model, data, seconds=1.5)

                for cam_pos, lookat, view in views:
                    arr = render(model, data, cam_pos, lookat)
                    safe_part = part_name.replace(".", "_")
                    out = out_dir / f"{safe_part}__{state_name}__{view}.png"
                    save_png(arr, out)
                    written.append(str(out.relative_to(HERE)))
            except Exception as e:  # noqa: BLE001
                failures.append((part_name, state_name, str(e)))
                print(f"   ! failed: {e}")

    print()
    print(f"states tested: {total}")
    print(f"pngs written:  {len(written)}")
    if failures:
        print(f"failures:      {len(failures)}")
        for p, s, err in failures:
            print(f"  - {p}.{s}: {err}")
        return 1

    # Index file for human review.
    index = out_dir / "_index.txt"
    with index.open("w") as f:
        f.write(f"profile: {profile_path.name}\nmodel: {model_path.name}\n\n")
        for line in written:
            f.write(line + "\n")
    print(f"index:         {index.relative_to(HERE)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
