# Where features live — the decision frame

> Replaces the earlier implicit "fat vs thin client" debate. We don't
> commit to either as an architecture; each feature gets placed where
> the trade-offs land for *that feature*.

## When deciding where a new feature lives

Score each option (run-on-device vs run-on-plat vs run-on-cloud) against
the criteria below. There's no formal scoring — this is a checklist to
make the trade-off explicit so the choice isn't accidental.

### 1. Latency needs
- Round-trip target for the feature (ms / sec / "user-perceivable")?
- Network hop count tolerable?
- Streaming or one-shot?

### 2. Device capability
- CPU / NPU / memory / battery available on the candidate device?
- Does the model / library exist for that platform?
- Is the device always-on, or charging-only, or mobile?

### 3. Implementation complexity
- How much new plumbing does this option require? (new transport,
  new build target, new ops surface)
- Can we reuse what's already in place?

### 4. Simplest solution possible
- What's the dumbest thing that could work?
- Will a v0 with no infrastructure get us 80% there?
- We pick the simplest option that satisfies the latency + capability
  constraints — not the "most architecturally pure" one.

### 5. Change management — how easy to update later
- If we ship this somewhere and later need to move it, what's the cost?
- Soft criterion — never blocks a decision on its own, but breaks ties
  toward the more portable option.

### 6. Best UX option
- Does this option enable a noticeably better feel for the user?
- E.g. on-device wake-word vs cloud wake-word — both feasible; the
  former feels instant and works offline.

## What this means in practice

- node-dock can keep running a local Koog agent for some tasks AND
  stream audio to plat for others. There's no architectural "everything
  goes here" decision.
- plat can stay small until a feature *needs* it (cross-device state,
  shared world model, GPU-bound inference, …).
- WebRTC, ROS2 bridge, MQTT, websockets, gRPC — all are tools we can
  pick per-feature, not declared up-front.

## When in doubt

Default to the device closest to where the work happens (mic input →
device with the mic, robot motion → robot, multi-device fusion →
plat). Move it elsewhere only when a clear criterion above forces it.
