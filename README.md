# orbit — personal robotics platform

Multi-device personal robotics: a mobile floor robot, one or more stationary desk companions, and a central agent / WebRTC SFU that bridges them.

## Layout

| Folder | What |
|---|---|
| [`docs/`](docs/) | Plan + TODO — read these first |
| [`plat/`](plat/) | Central platform service (agent, LLM, WebRTC SFU, world model). Stub. |
| [`node-rover/`](node-rover/) | Mobile floor robot (linorobot2-based, ROS2). Sim works through Nav2; hardware next. |
| [`node-dock/`](node-dock/) | Stationary desk companion (phone + optional servo body). Active — app + BodyLink sim built. |

## Start here

1. [`docs/plan.md`](docs/plan.md) — overall architecture and design
2. [`docs/TODO.md`](docs/TODO.md) — what's done and what's next
