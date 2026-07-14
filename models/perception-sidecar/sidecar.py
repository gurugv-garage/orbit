#!/usr/bin/env python3
"""
perception-sidecar — local HTTP service for the offline models the perception
processors call that need a Python runtime. Today: STT (mlx-whisper). Extensible
(add endpoints for other models here). Vision (moondream) does NOT use this — it
runs in Ollama directly, which is more efficient.

  POST /transcribe   {pcm_b64, sample_rate?} -> {text, latency_ms}
        pcm_b64 = base64 of raw 16-bit signed mono PCM little-endian.
        (The STT processor decodes the WebRTC Opus to PCM via ffmpeg and posts
         rolling windows here.)
  POST /api/generate {model, prompt, images:[b64], ...} -> {response, ...}
        moondream3 (MLX) vision, OLLAMA-COMPATIBLE shape — so the vision processor's
        existing Ollama client works unchanged; swapping moondream(Ollama)↔md3
        (sidecar) is just a base-URL change. Sharper than moondream2, no
        hallucinated background (see models/moondream/FINDINGS.md). Loaded lazily on
        first call unless --vision is passed.
  GET  /health       -> {ok, stt_model, vision_model}

  python3 sidecar.py --port 8078 --model mlx-community/whisper-small.en-mlx --vision

  # alternate STT engine — NVIDIA Parakeet-TDT via parakeet-mlx (same /transcribe
  # contract, but returns null confidence metrics; English/European only):
  python3 sidecar.py --port 8078 --engine parakeet

mlx-whisper runs Metal-accelerated on Apple Silicon; base.en is ~140MB and
transcribes a few-second window in well under real time. --engine selects whisper
(default) or parakeet; both run on the single MLX thread.
"""
from __future__ import annotations
import argparse, base64, json as _json, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# ALL MLX inference runs on this ONE dedicated thread. MLX/Metal is not
# thread-safe — sharing the Metal context across threads segfaults even under a
# lock, because the context is bound to the calling thread. A single-worker
# executor pins every model call to the same thread; the HTTP server stays
# threaded (health checks stay responsive) but inference is funnelled here.
MLX = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")

# job-id → 0..1 progress for an in-flight whole-file transcription (GET /progress).
# mlx-whisper transcribes in a single blocking call and imports tqdm LOCALLY (can't
# monkeypatch its progress bar), so we ESTIMATE: a background ticker advances the bar
# toward ~95% over the model's typical real-time factor (RTF) × audio duration, then
# the transcribe call snaps it to 100% when it returns. Honest moving estimate, no
# internals. RTF ≈ wall-seconds per audio-second on this box (small ~0.03, bigger more).
PROGRESS: dict = {}
import threading as _threading
RTF = {  # rough wall-seconds per audio-second, per model size (tune as observed)
    "tiny": 0.015, "base": 0.02, "small": 0.04, "medium": 0.09, "large": 0.18,
}


def _rtf_for(model: str) -> float:
    m = (model or "").lower()
    for k, v in RTF.items():
        if k in m:
            return v
    return 0.05


def _start_progress_ticker(job, audio_secs, model):
    """Advance PROGRESS[job] toward 0.95 over the estimated transcription time, in a
    daemon thread. Stops when PROGRESS[job] is set to 1.0 (or removed) by the caller."""
    est = max(1.0, audio_secs * _rtf_for(model))
    t0 = time.time()

    def run():
        while PROGRESS.get(job, 1.0) < 1.0:
            frac = min(0.95, (time.time() - t0) / est)
            cur = PROGRESS.get(job)
            if cur is None or cur >= 1.0:
                return
            PROGRESS[job] = frac
            time.sleep(0.4)
    th = _threading.Thread(target=run, daemon=True)
    th.start()


class Stt:
    def __init__(self, model: str):
        import mlx_whisper  # noqa: F401  (validate import at boot)
        self._mlx_whisper = mlx_whisper
        self.model = model
        # warm on the MLX thread (so the model's first GPU touch is there too).
        try:
            MLX.submit(lambda: self._mlx_whisper.transcribe(
                np.zeros(16000, dtype=np.float32), path_or_hf_repo=model)).result()
        except Exception:
            pass

    def transcribe(self, pcm_i16: np.ndarray, sample_rate: int) -> dict:
        # mlx-whisper wants float32 mono @ 16k. PCM int16 -> float32 [-1,1].
        audio = pcm_i16.astype(np.float32) / 32768.0
        if sample_rate != 16000:
            # cheap linear resample to 16k (windows are short; quality is fine).
            n = int(len(audio) * 16000 / sample_rate)
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        # Anti-hallucination: condition_on_previous_text=False stops the runaway
        # token loops on silence; no_speech_threshold + logprob filter drop
        # non-speech windows; temperature=0 keeps it deterministic.
        r = MLX.submit(lambda: self._mlx_whisper.transcribe(
            audio, path_or_hf_repo=self.model,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            logprob_threshold=-1.0,
            temperature=0.0,
        )).result()
        text = (r.get("text") or "").strip()
        # Surface Whisper's own confidence tells so the TS pipeline can flag shaky
        # transcripts on REAL signals (not just a phrase blacklist):
        #   avg_logprob       — mean token log-prob; very negative = unsure/garbled.
        #   no_speech_prob    — P(this was silence/noise); high = likely hallucination.
        #   compression_ratio — gzip ratio of text; high = repetitive loop ("you you …").
        # Aggregate across segments (duration-weighted for logprob; max for the rest,
        # since one bad segment is enough to distrust the line).
        segs = r.get("segments") or []
        avg_logprob = no_speech = comp = None
        if segs:
            tot = sum(max(1e-3, (s.get("end", 0) - s.get("start", 0))) for s in segs)
            avg_logprob = sum(s.get("avg_logprob", 0.0) * max(1e-3, (s.get("end", 0) - s.get("start", 0))) for s in segs) / tot
            no_speech = max(s.get("no_speech_prob", 0.0) for s in segs)
            comp = max(s.get("compression_ratio", 0.0) for s in segs)
        return {
            "text": text,
            "avg_logprob": avg_logprob,
            "no_speech_prob": no_speech,
            "compression_ratio": comp,
        }

    def transcribe_file(self, pcm_i16, sample_rate, model=None, initial_prompt=None, job=None):
        """Whole-file transcription for the capture-judging REPROCESS path: hand the
        WHOLE recording to Whisper (its own segmentation), with an optional MODEL
        override and an optional INITIAL_PROMPT (context bias — names/domain terms,
        to test context-aware transcription). Returns per-segment text + timing +
        Whisper's confidence metrics, so the console can tier + time-sync each segment.

        If `job` is given, reports % progress to PROGRESS[job] (the seek loop's
        position / total frames) so the console can show a real progress bar."""
        audio = pcm_i16.astype(np.float32) / 32768.0
        if sample_rate != 16000:
            n = int(len(audio) * 16000 / sample_rate)
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        repo = model or self.model
        if job:
            PROGRESS[job] = 0.0
            _start_progress_ticker(job, len(audio) / 16000.0, repo)
        try:
            r = MLX.submit(lambda: self._mlx_whisper.transcribe(
                audio, path_or_hf_repo=repo,
                initial_prompt=initial_prompt,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                temperature=0.0,
            )).result()
        finally:
            if job:
                PROGRESS[job] = 1.0  # snap to done (stops the ticker)
        segs = []
        for s in (r.get("segments") or []):
            segs.append({
                "start": s.get("start", 0.0), "end": s.get("end", 0.0),
                "text": (s.get("text") or "").strip(),
                "avg_logprob": s.get("avg_logprob"),
                "no_speech_prob": s.get("no_speech_prob"),
                "compression_ratio": s.get("compression_ratio"),
            })
        return {"model": repo, "text": (r.get("text") or "").strip(), "segments": segs}


class ParakeetStt:
    """NVIDIA Parakeet-TDT (MLX) STT — drop-in alternative to the Whisper `Stt`
    class behind the SAME /transcribe contract, selected with --engine parakeet.

    Loads the official NVIDIA weights from HF via the open-source `parakeet-mlx`
    package (we write NO model code; same pattern as mlx-whisper). Runs on the one
    MLX thread like every other model here.

    Contract difference vs Whisper: Parakeet is a transducer, so it has no
    no_speech_prob / compression_ratio / per-token avg_logprob to surface. We
    return those as None — stt-watch.ts's confidenceTier() already treats null
    metrics gracefully (falls back to text heuristics), so the loss is just
    Whisper's built-in hallucination tells, not a crash. Keep this in mind when
    comparing reliability, not only WER."""

    def __init__(self, model: str):
        from parakeet_mlx import from_pretrained  # validate at boot
        from parakeet_mlx.audio import get_logmel
        self._from_pretrained = from_pretrained
        self._get_logmel = get_logmel
        self.model = model
        self._m = MLX.submit(lambda: from_pretrained(model)).result()  # load on MLX thread

    def _transcribe_audio(self, audio: np.ndarray) -> tuple:
        import mlx.core as mx
        mel = self._get_logmel(mx.array(audio), self._m.preprocessor_config)
        res = self._m.generate(mel)
        if not res:
            return "", None
        text = (res[0].text or "").strip()
        # Parakeet's OWN confidence (parakeet-mlx ≥0.5: per-token, 0..1). Geometric
        # mean over the utterance = exp(mean token logprob) — the TDT analog of
        # Whisper's avg_logprob. Calibration on real dock audio (2026-07-14, n=75):
        # junk fragments <0.75, word-salad 0.75-0.85, real speech 0.85+, clean 0.95+.
        confs = [t.confidence for s in (res[0].sentences or []) for t in s.tokens
                 if getattr(t, "confidence", None) is not None]
        conf = float(np.exp(np.mean(np.log(np.array(confs) + 1e-10)))) if confs else None
        return text, conf

    def transcribe(self, pcm_i16: np.ndarray, sample_rate: int) -> dict:
        audio = pcm_i16.astype(np.float32) / 32768.0
        if sample_rate != 16000:
            n = int(len(audio) * 16000 / sample_rate)
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        text, conf = MLX.submit(lambda: self._transcribe_audio(audio)).result()
        # No Whisper tells (null → their TS gates stay dormant), but `confidence`
        # is parakeet's own token-confidence aggregate — the TS side tiers on it.
        return {"text": text, "avg_logprob": None, "no_speech_prob": None,
                "compression_ratio": None, "confidence": conf}

    def transcribe_file(self, pcm_i16, sample_rate, model=None, initial_prompt=None, job=None):
        """Whole-file path for the bench/reprocess harness. Parakeet has no
        per-segment Whisper metrics, no initial_prompt bias, and segments via its
        own sentence splitter — we return one segment spanning the clip so the
        contract shape matches. `model`/`initial_prompt` are ignored (logged once)."""
        audio = pcm_i16.astype(np.float32) / 32768.0
        if sample_rate != 16000:
            n = int(len(audio) * 16000 / sample_rate)
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        if job:
            PROGRESS[job] = 0.0
            _start_progress_ticker(job, len(audio) / 16000.0, "parakeet")
        try:
            text = MLX.submit(lambda: self._transcribe_audio(audio)).result()
        finally:
            if job:
                PROGRESS[job] = 1.0
        return {"model": self.model, "text": text, "segments": [{
            "start": 0.0, "end": len(audio) / 16000.0, "text": text,
            "avg_logprob": None, "no_speech_prob": None, "compression_ratio": None}]}


class Vision:
    """moondream3 (MLX) vision — reuses the benched MD3 runner so they can't drift.
    Loaded lazily (first /infer) since it costs ~5 GB GPU.

    MLX/Metal is NOT thread-safe: two concurrent inferences crash the process
    (segfault). The ThreadingHTTPServer can deliver overlapping requests, so we
    serialize all inference under a lock — only one MLX call runs at a time."""
    def __init__(self):
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "moondream", "bench"))
        from md3 import MD3  # noqa: WPS433
        self._m = MLX.submit(MD3).result()  # load ON the MLX thread
        self.model = "moondream3-preview-mlx-4bit"

    def infer(self, image_b64: str, instruction: str) -> str:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
        # all MLX work on the one MLX thread (see executor note at top).
        ans, _ = MLX.submit(lambda: self._m.ask(img, instruction, max_tokens=128)).result()
        return ans


class Temporal:
    """Qwen2.5-VL (MLX) multi-frame temporal reasoner. Loaded lazily (~3 GB GPU)."""
    def __init__(self):
        import sys, os
        sys.path.insert(0, os.path.dirname(__file__))
        from qwen_video import QwenVideo, DEFAULT_PROMPT  # noqa: WPS433
        self._q = MLX.submit(QwenVideo).result()  # load on the MLX thread
        self._default_prompt = DEFAULT_PROMPT
        self.model = self._q.model_id

    def describe(self, frames_b64, prompt=None) -> str:
        p = prompt or self._default_prompt
        return MLX.submit(lambda: self._q.describe(frames_b64, p)).result()


class VoiceEmbedder:
    """Speaker-embedding extractor (voice fingerprinting) via sherpa-onnx — CPU
    onnxruntime, so it does NOT go through the MLX thread. Validated 2026-07-14 on
    real dock audio: TitaNet-small matched torch-ECAPA's separation (guru 0.59-0.77
    vs non-guru ~0.0 cosine) at ~13ms/clip. A lock guards compute() because the
    HTTP server is threaded and one extractor instance is shared."""

    def __init__(self, model_path: str, threads: int = 2):
        import sherpa_onnx  # lazy: only required when --embed-model is passed
        self._sherpa = sherpa_onnx
        self._ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=threads))
        self._lock = _threading.Lock()
        self.model = model_path.rsplit("/", 1)[-1]

    def embed(self, pcm: np.ndarray, sr: int) -> list:
        """pcm: int16 mono. Returns a unit-norm embedding as a plain list."""
        x = pcm.astype(np.float32) / 32768.0
        with self._lock:
            s = self._ex.create_stream()
            s.accept_waveform(sr, x)
            s.input_finished()
            e = np.array(self._ex.compute(s), dtype=np.float32)
        n = float(np.linalg.norm(e))
        return (e / n).tolist() if n > 0 else e.tolist()


def make_handler(stt: Stt, vision_holder: dict, temporal_holder: dict, embedder: "VoiceEmbedder | None" = None):
    def get_vision() -> Vision:
        if vision_holder.get("v") is None:
            vision_holder["v"] = Vision()
        return vision_holder["v"]

    def get_temporal() -> Temporal:
        if temporal_holder.get("t") is None:
            temporal_holder["t"] = Temporal()
        return temporal_holder["t"]

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            # NaN/Inf (Whisper sometimes returns NaN logprobs) are invalid JSON for
            # strict parsers (JS JSON.parse). Emit null instead of a bare NaN token.
            def _clean(o):
                if isinstance(o, float):
                    return o if o == o and o not in (float("inf"), float("-inf")) else None
                if isinstance(o, dict):
                    return {k: _clean(v) for k, v in o.items()}
                if isinstance(o, list):
                    return [_clean(v) for v in o]
                return o
            body = _json.dumps(_clean(obj)).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                v = vision_holder.get("v")
                t = temporal_holder.get("t")
                self._send(200, {"ok": True, "stt_model": stt.model if stt else None,
                                 "vision_model": v.model if v else None,
                                 "temporal_model": t.model if t else None})
            elif self.path.startswith("/progress"):
                # /progress?job=ID → 0..1 progress of an in-flight transcribe_file.
                from urllib.parse import urlparse, parse_qs
                job = (parse_qs(urlparse(self.path).query).get("job") or [None])[0]
                self._send(200, {"job": job, "progress": PROGRESS.get(job, 0.0) if job else 0.0})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            n = int(self.headers.get("content-length", 0))
            try:
                req = _json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                self._send(400, {"error": f"bad json: {e}"})
                return

            if self.path == "/transcribe":
                if stt is None:
                    self._send(503, {"error": "stt not loaded (vision-only process)"})
                    return
                try:
                    pcm = np.frombuffer(base64.b64decode(req["pcm_b64"]), dtype=np.int16)
                    sr = int(req.get("sample_rate", 16000))
                except Exception as e:
                    self._send(400, {"error": f"bad request: {e}"})
                    return
                t0 = time.perf_counter()
                try:
                    out = stt.transcribe(pcm, sr)
                except Exception as e:
                    self._send(500, {"error": str(e)})
                    return
                out["latency_ms"] = (time.perf_counter() - t0) * 1e3
                # Voice fingerprint: same PCM, one roundtrip. Requested per-call so
                # the interim re-transcribe path never pays for it. Soft-fail: a
                # broken embedder must never cost the transcript.
                if req.get("embed") and embedder is not None:
                    te = time.perf_counter()
                    try:
                        out["embedding"] = embedder.embed(pcm, sr)
                        out["embed_ms"] = (time.perf_counter() - te) * 1e3
                    except Exception as e:
                        print(f"/transcribe embed failed: {e}", flush=True)
                # live-test visibility: one line per utterance so we can watch what
                # the STT engine actually hears in real conversation.
                print(f"/transcribe [{getattr(stt,'model','?')}] "
                      f"{out['latency_ms']:.0f}ms  {len(pcm)/sr:.1f}s  "
                      f"text={out.get('text')!r}", flush=True)
                self._send(200, out)
                return

            # Whole-file reprocess (capture-judging): optional model + initial_prompt.
            if self.path == "/transcribe_file":
                if stt is None:
                    self._send(503, {"error": "stt not loaded (vision-only process)"})
                    return
                try:
                    pcm = np.frombuffer(base64.b64decode(req["pcm_b64"]), dtype=np.int16)
                    sr = int(req.get("sample_rate", 16000))
                except Exception as e:
                    self._send(400, {"error": f"bad request: {e}"})
                    return
                t0 = time.perf_counter()
                job = req.get("job")
                try:
                    out = stt.transcribe_file(pcm, sr, model=req.get("model"),
                                              initial_prompt=req.get("initial_prompt"), job=job)
                except Exception as e:
                    if job:
                        PROGRESS.pop(job, None)
                    self._send(500, {"error": str(e)})
                    return
                if job:
                    PROGRESS.pop(job, None)  # done; drop the slot
                out["latency_ms"] = (time.perf_counter() - t0) * 1e3
                self._send(200, out)
                return

            # Ollama-compatible vision: same shape as Ollama's /api/generate, so the
            # vision processor's existing Ollama client works unchanged — swapping
            # moondream(Ollama)↔md3(sidecar) is just a URL change. See models/README.
            if self.path == "/api/generate":
                img_list = req.get("images") or []
                instr = req.get("prompt")
                if not img_list or not instr:
                    self._send(400, {"error": "prompt and images required"})
                    return
                t0 = time.perf_counter()
                try:
                    answer = get_vision().infer(img_list[0], instr)
                except Exception as e:
                    self._send(500, {"error": str(e)})
                    return
                self._send(200, {
                    "model": req.get("model", "moondream3"),
                    "response": answer,
                    "done": True,
                    "total_duration": int((time.perf_counter() - t0) * 1e9),
                })
                return

            # Temporal: N ordered frames → an action description (qwen2.5-VL video).
            if self.path == "/temporal":
                frames = req.get("frames") or []
                # 1 frame is allowed: the station's window-dedup collapses a static window to a
                # single still frame (nothing moved), sending it with a still-image prompt. qwen
                # handles a single image on the same path (num_images=1). 0 frames is the error.
                if len(frames) < 1:
                    self._send(400, {"error": "need >=1 frame"})
                    return
                t0 = time.perf_counter()
                try:
                    answer = get_temporal().describe(frames, req.get("prompt"))
                except Exception as e:
                    self._send(500, {"error": str(e)})
                    return
                self._send(200, {"response": answer, "frames": len(frames),
                                 "latency_ms": (time.perf_counter() - t0) * 1e3})
                return

            self._send(404, {"error": "not found"})

    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8078)
    ap.add_argument("--host", default="127.0.0.1")
    # DEFAULT = parakeet (changed from whisper 2026-06-22). Live end-to-end test on
    # the anne-bot dock (far-field, over WebRTC) transcribed real accented
    # conversational speech word-perfect at 114-240ms — faster + lower WER than
    # whisper-small.en, and it even nailed Indian loanwords ("Amma", "puja"). Two
    # trade-offs to remember: (1) Parakeet is English/European only — a full Hindi
    # SENTENCE (not a loanword) will likely break; (2) it returns null for Whisper's
    # confidence tells (no_speech_prob/compression_ratio/avg_logprob), so the
    # hallucination-tier safety net in stt-watch.ts is inactive under it (fine in a
    # quiet room, riskier far-field/noisy). Pass --engine whisper to fall back.
    ap.add_argument("--engine", default="parakeet", choices=["whisper", "parakeet"],
                    help="STT engine. parakeet (default) = NVIDIA Parakeet-TDT via "
                         "parakeet-mlx; whisper = mlx-whisper. Same /transcribe "
                         "contract; parakeet returns null confidence metrics.")
    ap.add_argument("--model", default=None,
                    help="STT model HF id. Defaults per --engine: "
                         "whisper→mlx-community/whisper-small.en-mlx, "
                         "parakeet→mlx-community/parakeet-tdt-0.6b-v3.")
    ap.add_argument("--vision", action="store_true", help="preload md3 vision at boot")
    ap.add_argument("--temporal", action="store_true", help="preload qwen temporal at boot")
    ap.add_argument("--no-stt", action="store_true",
                    help="vision-only: don't load whisper. Run STT and the MLX vision "
                         "models in SEPARATE processes — two MLX models in one process "
                         "can crash Metal.")
    ap.add_argument("--embed-model", default=None,
                    help="path to a speaker-embedding .onnx (voice fingerprinting; "
                         "e.g. nemo_en_titanet_small.onnx from "
                         "github.com/k2-fsa/sherpa-onnx/releases 'speaker-recongition-models'). "
                         "When set, /transcribe requests with embed:true also return "
                         "'embedding' (unit-norm) + 'embed_ms'. CPU via sherpa-onnx.")
    a = ap.parse_args()
    stt = None
    if not a.no_stt:
        model = a.model or (
            "mlx-community/parakeet-tdt-0.6b-v3" if a.engine == "parakeet"
            else "mlx-community/whisper-small.en-mlx")
        print(f"loading STT engine={a.engine} {model} …")
        t0 = time.perf_counter()
        stt = ParakeetStt(model) if a.engine == "parakeet" else Stt(model)
        print(f"  ready in {time.perf_counter()-t0:.1f}s")
    vision_holder: dict = {"v": None}
    if a.vision:
        print("loading md3 vision …")
        tv = time.perf_counter()
        vision_holder["v"] = Vision()
        print(f"  ready in {time.perf_counter()-tv:.1f}s")
    temporal_holder: dict = {"t": None}
    if a.temporal:
        print("loading qwen temporal …")
        tt = time.perf_counter()
        temporal_holder["t"] = Temporal()
        print(f"  ready in {time.perf_counter()-tt:.1f}s")
    embedder = None
    if a.embed_model:
        # Soft-load: a missing model file or missing sherpa-onnx must not take the
        # STT sidecar down — voice fingerprinting is an optional add-on.
        try:
            print(f"loading voice embedder {a.embed_model} …")
            tv2 = time.perf_counter()
            embedder = VoiceEmbedder(a.embed_model)
            print(f"  ready in {time.perf_counter()-tv2:.1f}s")
        except Exception as e:
            print(f"  voice embedder DISABLED: {e}")
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(stt, vision_holder, temporal_holder, embedder))
    print(f"perception-sidecar on http://{a.host}:{a.port}  (POST /transcribe, /api/generate, /temporal, GET /health)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
