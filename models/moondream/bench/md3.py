#!/usr/bin/env python3
"""
moondream3-preview runner via mlx-vlm (the repo is MLX-quantized 4-bit, so it
loads with mlx_vlm, NOT transformers). Exposes a simple prompt→text call so we
can compare md3 head-to-head with md2 (Ollama) on the same frames, including the
documented "return as json: a, b, c" phrasing (md3's query skill emits JSON from
that prompt with no format flag).

    python3 md3.py --selftest
    from md3 import MD3; m = MD3(); m.ask(pil_image, "return as json: present, activity")
"""
from __future__ import annotations
import sys, time
from typing import Optional

MODEL_ID = "beshkenadze/moondream3-preview-mlx-4bit"


class MD3:
    def __init__(self, model_id: str = MODEL_ID):
        from mlx_vlm import load
        from mlx_vlm.prompt_utils import apply_chat_template
        t0 = time.perf_counter()
        self.model, self.processor = load(model_id, trust_remote_code=True)
        self.config = self.model.config
        self._apply_template = apply_chat_template
        self.load_s = time.perf_counter() - t0

    def ask(self, image, prompt: str, max_tokens: int = 128) -> tuple[str, float]:
        """One prompt+image → text. Mirrors md2's path so the comparison is fair."""
        from mlx_vlm import generate
        formatted = self._apply_template(self.processor, self.config, prompt, num_images=1)
        t0 = time.perf_counter()
        out = generate(
            self.model, self.processor, formatted, image=[image],
            max_tokens=max_tokens, temperature=0.0, verbose=False,
        )
        ms = (time.perf_counter() - t0) * 1e3
        text = out.text if hasattr(out, "text") else str(out)
        return _clean(text), ms


def _clean(text: str) -> str:
    """mlx-vlm's generic generate doesn't stop on md3's end-of-turn token, so the
    output carries <|md_reserved_*|> markers and often repeats. Strip the markers
    and cut at the end-of-turn (md_reserved_2) or the first duplicated half."""
    import re
    # cut at end-of-turn marker if present
    text = text.split("<|md_reserved_2|>")[0]
    text = re.sub(r"<\|md_reserved_\d+\|>", "", text).strip()
    # de-dup: if the string is exactly doubled, keep one copy
    half = len(text) // 2
    if half > 10 and text[:half].strip() == text[half:].strip():
        text = text[:half].strip()
    return text


def _selftest():
    from PIL import Image
    import cv2
    print(f"loading {MODEL_ID} via mlx-vlm …")
    m = MD3()
    print(f"loaded in {m.load_s:.1f}s")

    cam = cv2.VideoCapture(0)
    for _ in range(5):
        cam.read(); time.sleep(0.05)
    ok, frame = cam.read()
    cam.release()
    frame = cv2.resize(frame, (320, 240))  # the dock's stream res
    pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

    for label, prompt in [
        ("query NL", "What is in the image and what is happening?"),
        ("documented JSON phrasing", "return as json: present, activity, unusual"),
        ("typed JSON", 'Return JSON with keys present (bool), activity (string), unusual (string).'),
    ]:
        ans, ms = m.ask(pil, prompt)
        print(f"\n-- {label} --\n  {ms:.0f}ms  {ans}")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print("use --selftest, or import MD3")
