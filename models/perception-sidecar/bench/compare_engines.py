#!/usr/bin/env python3
"""
Compare STT engines (whisper vs parakeet) on the curated a1-test-audio clips,
which have known ground-truth transcripts (docs/findings/a1-test-plan.md).

Loads BOTH engines directly (no sidecar/HTTP) and runs each clip through both,
printing per-clip WER + latency and an overall summary. This is the "run both
through an option" check before deciding whether to switch the sidecar default.

  python3 compare_engines.py                 # both engines, a1-test-audio
  python3 compare_engines.py --engines whisper
  python3 compare_engines.py --dir <other wav dir>   # no refs → text-only

Notes:
- WER uses jiwer if available, else a builtin token-level fallback.
- a1 clips are clean American English; this is a BASELINE, not an accent test.
  For Indian-accent reality, record new clips into a dir and re-run with --dir
  (you supply the references in REFS or via a refs.json {filename: text}).
"""
from __future__ import annotations
import argparse, json, os, time, wave
import numpy as np

# Ground truth for the committed a1-test-audio clips (from a1-test-plan.md).
REFS = {
    "q-math.wav": "What is two plus two?",
    "q-capital.wav": "What is the capital of France?",
    "q-time.wav": "What time is it right now?",
    "greeting.wav": "Hey, can you hear me?",
    "barge-stop.wav": "Stop, what time is it?",
    "followup.wav": "And what about the sun?",
    "long-story.wav": "Tell me a long story about the moon.",
}

WHISPER_MODEL = "mlx-community/whisper-small.en-mlx"
PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"


def normalize(text: str) -> str:
    import re
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9' ]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def wer(ref: str, hyp: str) -> float:
    ref, hyp = normalize(ref), normalize(hyp)
    try:
        import jiwer
        return jiwer.wer(ref, hyp) if ref else (0.0 if not hyp else 1.0)
    except Exception:
        # Levenshtein on word tokens.
        r, h = ref.split(), hyp.split()
        if not r:
            return 0.0 if not h else 1.0
        d = list(range(len(h) + 1))
        for i in range(1, len(r) + 1):
            prev, d[0] = d[0], i
            for j in range(1, len(h) + 1):
                cur = d[j]
                d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
                prev = cur
        return d[len(h)] / len(r)


def read_wav_16k(path: str) -> np.ndarray:
    w = wave.open(path)
    sr, n = w.getframerate(), w.getnframes()
    pcm = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if w.getnchannels() == 2:
        pcm = pcm.reshape(-1, 2).mean(axis=1)
    if sr != 16000:
        m = int(len(pcm) * 16000 / sr)
        pcm = np.interp(np.linspace(0, len(pcm), m, endpoint=False),
                        np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


class WhisperEngine:
    name = "whisper"
    def __init__(self):
        import mlx_whisper
        self._w = mlx_whisper
    def transcribe(self, audio):
        r = self._w.transcribe(audio, path_or_hf_repo=WHISPER_MODEL,
                               condition_on_previous_text=False, temperature=0.0)
        return (r.get("text") or "").strip()


class ParakeetEngine:
    name = "parakeet"
    def __init__(self):
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel
        self._mx, self._mel = mx, get_logmel
        self._m = from_pretrained(PARAKEET_MODEL)
    def transcribe(self, audio):
        mel = self._mel(self._mx.array(audio), self._m.preprocessor_config)
        res = self._m.generate(mel)
        return (res[0].text if res else "").strip()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_dir = os.path.normpath(os.path.join(here, "..", "..", "..",
                                                 "docs", "findings", "a1-test-audio"))
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=default_dir, help="directory of .wav clips")
    ap.add_argument("--engines", nargs="+", default=["whisper", "parakeet"],
                    choices=["whisper", "parakeet"])
    a = ap.parse_args()

    clips = sorted(f for f in os.listdir(a.dir) if f.endswith(".wav"))
    if not clips:
        print(f"no .wav files in {a.dir}")
        return
    refs = dict(REFS)
    refs_file = os.path.join(a.dir, "refs.json")
    if os.path.exists(refs_file):
        refs.update(json.load(open(refs_file)))

    print(f"dir: {a.dir}\nclips: {len(clips)}  engines: {a.engines}\n")
    engines = []
    for name in a.engines:
        print(f"loading {name} …", flush=True)
        t0 = time.perf_counter()
        engines.append((WhisperEngine if name == "whisper" else ParakeetEngine)())
        print(f"  ready in {time.perf_counter()-t0:.1f}s")
    print()

    totals = {e.name: {"wer_sum": 0.0, "n_ref": 0, "infer": 0.0, "audio": 0.0} for e in engines}
    for clip in clips:
        audio = read_wav_16k(os.path.join(a.dir, clip))
        ref = refs.get(clip)
        dur = len(audio) / 16000
        print(f"── {clip}  ({dur:.1f}s)" + (f'   REF: "{ref}"' if ref else "  (no ref)"))
        for e in engines:
            t0 = time.perf_counter()
            hyp = e.transcribe(audio)
            dt = time.perf_counter() - t0
            t = totals[e.name]
            t["infer"] += dt; t["audio"] += dur
            line = f'   {e.name:9s} {dt*1000:6.0f}ms  "{hyp}"'
            if ref is not None:
                w = wer(ref, hyp)
                t["wer_sum"] += w; t["n_ref"] += 1
                line += f"   WER={w:5.1%}"
            print(line)
        print()

    print("=" * 64)
    for e in engines:
        t = totals[e.name]
        rtf = t["infer"] / t["audio"] if t["audio"] else 0
        avg_wer = (t["wer_sum"] / t["n_ref"]) if t["n_ref"] else None
        wer_s = f"avg WER {avg_wer:.1%} over {t['n_ref']} refs" if avg_wer is not None else "no refs"
        print(f"{e.name:9s} | {wer_s} | {1/rtf:.0f}x realtime "
              f"({t['infer']:.1f}s infer / {t['audio']:.0f}s audio)")


if __name__ == "__main__":
    main()
