# orbit icons

A small set of SVG marks for the orbit platform. Motif: a glowing planet
(`#5db8ff`) with a tilted orbit ring (`#8f7bff`) and a satellite (`#4ad6a0`) —
the same look as the inline favicon in `web/index.html` and the space-themed UI.

| File | Use |
|---|---|
| `orbit-mark.svg` | The primary mark (64×64): planet + ring + satellite on transparent. Use in the UI header, READMEs, slides. |
| `orbit-badge.svg` | App badge (128×128, rounded dark tile): planet, twin rings, stars. Use for app icons / avatars (e.g. the Slack app icon). |
| `orbit-favicon.svg` | Compact 32×32 favicon (planet + one ring). |
| `orbit-mono.svg` | Single-color line mark using `currentColor` — inherits the surrounding text color. Use where a flat/themable icon is needed. |

Palette (from the web theme): planet `#5db8ff`, ring `#8f7bff`,
satellite/accent `#4ad6a0`, warm accent `#ffc861`, space `#070a11`–`#1e2740`.

For a PNG (e.g. Slack wants a square PNG for the app icon), rasterize the badge:

```bash
# any SVG→PNG tool works; e.g. with rsvg-convert or resvg:
rsvg-convert -w 512 -h 512 orbit-badge.svg -o orbit-badge-512.png
```
