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
| `orbit-app-icon-1024.png` | **1024×1024 filled-square PNG** of the badge — for places that require a raster square icon (e.g. the **Slack app icon**, which must be a square PNG between 512×512 and 2000×2000). |

Palette (from the web theme): planet `#5db8ff`, ring `#8f7bff`,
satellite/accent `#4ad6a0`, warm accent `#ffc861`, space `#070a11`–`#1e2740`.

`orbit-app-icon-1024.png` is already provided for the Slack app icon. To
regenerate it (or another size), rasterize the badge and flatten the rounded
corners onto the space color so it's a clean filled square:

```bash
# cairosvg renders SVG gradients correctly (ImageMagick's SVG renderer doesn't):
python3 -c "import cairosvg; cairosvg.svg2png(url='orbit-badge.svg', \
  write_to='orbit-app-icon-1024.png', output_width=1024, output_height=1024)"
magick orbit-app-icon-1024.png -background '#070a11' -flatten orbit-app-icon-1024.png
```
