#!/usr/bin/env python3
"""
Export DINOv2-small to ONNX for the in-process vision change-gate (embed.ts). Run once;
the station auto-runs this on boot if the ONNX is missing (see embed.ts ensureModel).
The 84MB output is gitignored — it's a deterministic export from a pinned torch.hub model,
not source. Requires: torch + onnx (a dev/build-time dependency, not a runtime one).

    python3 scripts/export-dino.py [out_path]
"""
import sys, os, warnings
warnings.filterwarnings("ignore")

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "models", "embed", "dinov2_vits14.onnx")
OUT = os.path.abspath(OUT)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

if os.path.exists(OUT):
    print(f"[export-dino] already present: {OUT} ({os.path.getsize(OUT)//1_000_000}MB)")
    sys.exit(0)

import torch
base = torch.hub.load("facebookresearch/dinov2", "dinov2_vits14", verbose=False).eval()

class Wrap(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, img): return s.m(img)   # CLS token, 384-d — image input only (no masks)

torch.onnx.export(Wrap(base).eval(), torch.randn(1, 3, 224, 224), OUT,
    input_names=["img"], output_names=["emb"],
    dynamic_axes={"img": {0: "b"}, "emb": {0: "b"}}, opset_version=17)
print(f"[export-dino] exported {OUT} ({os.path.getsize(OUT)//1_000_000}MB)")
