#!/usr/bin/env python3
"""
Qwen2.5-VL (MLX) temporal runner — reasons over MULTIPLE frames as a video, using
mlx-vlm's native multi-image/video path (temporal position encoding). This is the
TEMPORAL tier: per-frame vision (moondream/md3) says "what's there"; this says
"what's happening over time" (eating, leaving, gesturing) — actions that need
several frames.

Why MLX not Ollama: the same 3B model gets motion RIGHT via MLX's temporal
encoding and WRONG via Ollama's separate-images path (tested — see
models/README / the temporal findings). MLX is also ~12x faster here.

Used by the perception-sidecar /temporal endpoint. Import-light; the model loads
on construction (~3 GB GPU).
"""
from __future__ import annotations
import io, time
import base64


MODEL = "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"

DEFAULT_PROMPT = (
    "These are sequential video frames from a webcam, in order. In one short sentence, "
    "describe the scene AND what is happening over time: who/what is visible and any "
    "action or movement across the frames (e.g. 'a man sitting and typing', 'someone "
    "waving', 'a person leaves the room', 'an empty room'). "
    "If no person is visible, say so plainly and do not invent one."
)


class QwenVideo:
    def __init__(self, model_id: str = MODEL):
        from mlx_vlm import load
        from mlx_vlm.prompt_utils import apply_chat_template
        t0 = time.time()
        self.model, self.processor = load(model_id)
        self.config = self.model.config
        self._apply = apply_chat_template
        self.model_id = model_id
        self.load_s = time.time() - t0

    def describe(self, frames_b64: list[str], prompt: str = DEFAULT_PROMPT,
                 max_tokens: int = 96) -> str:
        """frames_b64 = ordered JPEG frames (base64). Returns an action sentence."""
        from PIL import Image
        from mlx_vlm import generate
        imgs = [Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB")
                for b in frames_b64]
        formatted = self._apply(self.processor, self.config, prompt, num_images=len(imgs))
        out = generate(self.model, self.processor, formatted, image=imgs,
                       max_tokens=max_tokens, temperature=0.0, verbose=False)
        text = out.text if hasattr(out, "text") else str(out)
        return text.strip()


if __name__ == "__main__":
    import sys, glob
    q = QwenVideo()
    print(f"loaded {q.load_s:.1f}s")
    files = sorted(glob.glob("/tmp/temporal/mv_*.jpg"))
    fb = [base64.b64encode(open(f, "rb").read()).decode() for f in files]
    print(q.describe(fb, "Which way does the red circle move and does the blue bar grow?"))
