#!/usr/bin/env python3
"""
WER benchmark for the perception STT path, against a real HuggingFace ASR
dataset (default: argmaxinc/earnings22-openbench — hard: accents, finance jargon,
spontaneous speech). Measures Word Error Rate of the EXACT models the sidecar
runs (mlx-whisper), so the number reflects production, not a different setup.

Earnings22 clips are full ~hour calls, so each is sliced into fixed segments and
the matching slice of the reference word-list is used — giving many short
utterances close to our real per-utterance STT.

  # clean English baseline (LibriSpeech — per-utterance, no slicing):
  python3 wer.py --suite librispeech --n 30
  # hard accented/jargon stress (Earnings-22, sliced):
  python3 wer.py --suite earnings22 --clips 2 --segments 4

Two suites:
  librispeech  — LibriSpeech test-clean, clean read English, short utterances
                 already aligned to text. The trustworthy ENGLISH baseline.
  earnings22   — argmaxinc/earnings22-openbench, hour-long accented calls sliced
                 into segments. A stress test, not the baseline.

Bypasses torchcodec (which fails to load on this box) by reading the parquet
audio BYTES and decoding with ffmpeg → 16 kHz mono PCM.
"""
from __future__ import annotations
import argparse, io, subprocess, sys, time
import numpy as np


def decode_wav_bytes(b: bytes, target_sr: int = 16000) -> np.ndarray:
    """WAV/any bytes → 16 kHz mono float32 via ffmpeg (no torchcodec)."""
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-ar", str(target_sr), "-ac", "1", "-f", "s16le", "pipe:1"],
        input=b, capture_output=True)
    pcm = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return pcm


def normalize(text) -> str:
    """Lowercase, strip punctuation — standard WER normalization."""
    import re
    if isinstance(text, list):
        text = " ".join(text)
    text = text.lower()
    text = re.sub(r"[^a-z0-9' ]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def run_librispeech(a, mlx_whisper, jiwer):
    """Clean English baseline: LibriSpeech test-clean, per-utterance (no slicing)."""
    import datasets
    from datasets import load_dataset
    ds = load_dataset("openslr/librispeech_asr", "clean", split="test", streaming=True)
    ds = ds.cast_column("audio", datasets.Audio(decode=False))
    refs, hyps, total_audio_s, total_infer_s = [], [], 0.0, 0.0
    for i, rec in enumerate(ds):
        if i >= a.n:
            break
        pcm = decode_wav_bytes(rec["audio"]["bytes"])
        ref = normalize(rec["text"])
        t0 = time.perf_counter()
        r = mlx_whisper.transcribe(pcm, path_or_hf_repo=a.model,
                                   condition_on_previous_text=False, temperature=0.0)
        total_infer_s += time.perf_counter() - t0
        total_audio_s += len(pcm) / 16000
        hyp = normalize(r.get("text", ""))
        refs.append(ref); hyps.append(hyp)
        if jiwer.wer(ref, hyp) > 0:
            print(f"[{i}] WER={jiwer.wer(ref,hyp):5.1%}  REF: {ref[:70]}\n         HYP: {hyp[:70]}")
    return refs, hyps, total_audio_s, total_infer_s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mlx-community/whisper-small.en-mlx")
    ap.add_argument("--suite", default="librispeech", choices=["librispeech", "earnings22"])
    ap.add_argument("--n", type=int, default=30, help="librispeech: # utterances")
    ap.add_argument("--clips", type=int, default=2, help="earnings22: # recordings")
    ap.add_argument("--seg", type=int, default=30, help="earnings22: segment length (s)")
    ap.add_argument("--segments", type=int, default=5, help="earnings22: segments/recording")
    a = ap.parse_args()

    import datasets, jiwer, mlx_whisper
    from datasets import load_dataset

    if a.suite == "librispeech":
        refs, hyps, total_audio_s, total_infer_s = run_librispeech(a, mlx_whisper, jiwer)
        overall = jiwer.wer(refs, hyps)
        rtf = total_infer_s / total_audio_s if total_audio_s else 0
        print("\n" + "=" * 60)
        print(f"MODEL: {a.model}   SUITE: librispeech (clean English)")
        print(f"utterances: {len(refs)}   overall WER: {overall:.1%}")
        print(f"speed: {1/rtf:.0f}x faster than realtime" if rtf else "")
        return

    ds = load_dataset("argmaxinc/earnings22-openbench", "3hours", split="test", streaming=True)
    ds = ds.cast_column("audio", datasets.Audio(decode=False))

    refs, hyps, total_audio_s, total_infer_s = [], [], 0.0, 0.0
    n = 0
    for rec in ds:
        if n >= a.clips:
            break
        n += 1
        pcm = decode_wav_bytes(rec["audio"]["bytes"])
        words = rec["transcript"]  # list of words for the WHOLE recording
        sr = 16000
        seg_samples = a.seg * sr
        # words-per-second to slice the reference proportionally to the audio.
        dur = len(pcm) / sr
        wps = len(words) / dur if dur else 0

        for k in range(a.segments):
            start = k * seg_samples
            if start + seg_samples > len(pcm):
                break
            seg = pcm[start:start + seg_samples]
            ref_slice = words[int(k * a.seg * wps): int((k + 1) * a.seg * wps)]
            ref = normalize(ref_slice)
            if len(ref.split()) < 5:
                continue

            t0 = time.perf_counter()
            r = mlx_whisper.transcribe(
                seg, path_or_hf_repo=a.model,
                condition_on_previous_text=False, temperature=0.0)
            total_infer_s += time.perf_counter() - t0
            total_audio_s += len(seg) / sr
            hyp = normalize(r.get("text", ""))

            refs.append(ref); hyps.append(hyp)
            wer = jiwer.wer(ref, hyp)
            print(f"[{rec['audio_id']} seg{k}] WER={wer:5.1%} "
                  f"({rec.get('country_by_ticker','?')}, {rec.get('major_dialect_family','?')})")
            print(f"   REF: {ref[:100]}")
            print(f"   HYP: {hyp[:100]}")

    overall = jiwer.wer(refs, hyps)
    rtf = total_infer_s / total_audio_s if total_audio_s else 0
    print("\n" + "=" * 60)
    print(f"MODEL: {a.model}")
    print(f"segments: {len(refs)}   overall WER: {overall:.1%}")
    print(f"speed: {total_infer_s:.1f}s infer / {total_audio_s:.0f}s audio "
          f"= {rtf:.3f}x real-time ({1/rtf:.0f}x faster than realtime)")


if __name__ == "__main__":
    main()
