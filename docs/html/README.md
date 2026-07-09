# docs/html — rich HTML docs

Self-contained HTML documents that carry a visual design the markdown docs
can't — colored planes, side-by-side legends, ASCII data-flow diagrams. Use
these when the *shape* of a thing (two planes crossing, a fan-out, a pipeline)
is the point and plain prose flattens it.

## Viewing

- **Locally:** open the `.html` file in a browser (double-click / `file://`).
  Fully styled, no network needed — fonts are system stacks and the stylesheet
  is a sibling file. Theme follows your OS (light/dark).
- **On GitHub:** the repo view shows raw source, not the rendered page (GitHub
  renders `.md`, not `.html`). To serve the rendered pages, enable GitHub Pages
  for the repo; they're then reachable under the Pages URL.

## Shared design system

Every doc links `assets/doc.css` — one stylesheet so the whole set reads as one
system (theme-aware tokens, a control-plane *wire* blue + media-plane *accent*
cyan, code/diagram/callout/card components). Class vocabulary is documented
inline at the top of that file. New docs should link it rather than inline their
own CSS, so a design change lands everywhere at once.

Convention: the two planes get consistent color — **control/WS = wire (blue)**,
**media/WebRTC = accent (cyan)** — across every diagram and table here.

## Contents

- [`ws-webrtc-dataflow.html`](ws-webrtc-dataflow.html) — the two transports (WS
  control plane via `WebSocketGateway`, WebRTC media plane via `Sfu` →
  `PerceptionProcessingHub`), how a packet becomes perception, and where the two
  planes cross (the Bus, by topic). Companion to
  [`../modules/websocket-gateway.md`](../modules/websocket-gateway.md) and
  [`../modules/perception-processing-hub.md`](../modules/perception-processing-hub.md).
