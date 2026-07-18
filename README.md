# orbit

<p align="center">
  <video src="docs/media/dock-hero.mp4" poster="docs/media/dock-hero.jpg"
         width="640" autoplay loop muted playsinline></video>
  <!-- GitHub auto-plays this inline (muted); the poster .jpg shows on
       mirrors that don't render <video>. Both live in docs/media/. -->
</p>

**Hackable always-on robots.**

👁 sees &nbsp;·&nbsp; 👂 hears &nbsp;·&nbsp; 🗣 talks &nbsp;·&nbsp; 🤖 moves &nbsp;·&nbsp; 🌱 grows

An experiment: put an always-on system in your space — seeing, hearing,
moving, talking — and find out what it unlocks. Its purpose isn't fixed; it
learns one, or you teach it.

A hackable platform. It connects vision, audio, and language models — all
swappable — to physical bodies you build and extend yourself. Each part you
add exposes more capability, and widens the surface area of what's possible.

Today a desk companion: a phone and two servos. Tomorrow wheels, then wings,
then a wearable. As the AI space evolves, you evolve your system alongside it
and see what opens up.

And as it spends time with you in your space, it grows a personality of its
own, and — hopefully — a relationship with you.

## How it works

One brain, many bodies — every device streams what it senses into one shared
perception layer, agents reason over it and act back out, and the robot senses
its own actions. A closed loop.

<p align="center">
  <video src="docs/media/architecture-diagram.mp4" width="900" autoplay loop muted playsinline></video>
  <!-- Live/animated source: docs/media/architecture-diagram.html -->
</p>

## Layout

| Folder | What |
|---|---|
| [`docs/`](docs/) | Plan + TODO — read these first |
| [`node-dock/`](node-dock/) | Stationary desk companion (phone + servo body). Active — the part under development. |
| [`orbit-station/`](orbit-station/) | Central brain + control plane (agent sessions, perception, body motion, browser console). Active. |
| [`node-rover/`](node-rover/) | Mobile floor robot (linorobot2-based, ROS2). Sim works through Nav2; hardware next. |

## Start here

1. [`docs/PLAN.md`](docs/PLAN.md) — overall architecture and design
2. [`docs/TODO.md`](docs/TODO.md) — what's done and what's next
