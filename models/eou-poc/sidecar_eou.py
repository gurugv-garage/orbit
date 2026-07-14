"""EOU sidecar (POC-1, docs/poc-plans/stt-poc.md) — semantic end-of-utterance over
a WebSocket, so the station's UtteranceDetector can endpoint on MEANING instead of
waiting out the full 1300ms silence budget.

Run:  ./venv/bin/python sidecar_eou.py   (ws://127.0.0.1:8077)

Protocol (one WS connection per audio stream):
  client → binary frames: 16 kHz mono int16 PCM (any framing; buffered here)
  client → text {"type":"reset"}: utterance committed upstream — drop the buffer
  server → text {"type":"eou","text":...}   the model declared the speaker done
           {"type":"partial","text":...}    decode ran, no EOU yet (debug/observability)

POC decode strategy (honest about its shortcut): every DECODE_EVERY_MS of new audio,
re-decode the WHOLE buffer offline and look for a trailing <EOU> token. This adds
decode latency (~RTF 0.1 × buffer seconds) on top of the model's native streaming
latency — a true cache-aware streaming loop (NeMo voice-agent) is the production
path if the POC gate passes. Buffer capped at BUFFER_CAP_S (long utterances fall
back to the station's silence timeout, which is unchanged).
"""
import asyncio
import json
import tempfile
import time
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

PORT = 8077
DECODE_EVERY_MS = 480       # decode cadence: every ~half second of new audio
MIN_DECODE_MS = 1200        # don't judge sub-1.2s buffers (premature <EOU> on fragments)
BUFFER_CAP_S = 25
MODEL = "nvidia/parakeet_realtime_eou_120m-v1"

# One decode at a time (CPU model, single instance) — mirrors the MLX-thread pattern.
POOL = ThreadPoolExecutor(max_workers=1)
model = None  # loaded in main()


def decode(pcm: np.ndarray) -> str:
    """Offline decode of the buffered utterance; returns raw text (may end <EOU>)."""
    with tempfile.NamedTemporaryFile(suffix=".wav") as t:
        with wave.open(t.name, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(pcm.tobytes())
        out = model.transcribe([t.name], verbose=False)
        return (out[0].text or "").strip() if out else ""


async def handle(ws):
    buf = np.zeros(0, dtype=np.int16)
    since_decode_ms = 0.0
    eou_sent = False  # (unused after de-latching; kept for reset parity)
    loop = asyncio.get_running_loop()
    async for msg in ws:
        if isinstance(msg, (bytes, bytearray)):
            add = np.frombuffer(msg, dtype=np.int16)
            buf = np.concatenate([buf, add])
            if len(buf) > BUFFER_CAP_S * 16000:
                buf = buf[-BUFFER_CAP_S * 16000:]
            since_decode_ms += len(add) / 16.0
            if since_decode_ms >= DECODE_EVERY_MS and len(buf) >= MIN_DECODE_MS * 16:
                since_decode_ms = 0.0
                # Don't burn a decode on ambient hum: require real energy in the buffer
                # (the station resets us at each speech onset, so this rarely blocks a
                # true utterance — it blocks the between-utterance ambience stream).
                peak = float(np.max(np.abs(buf))) / 32768.0
                if peak < 0.04:
                    continue
                t0 = time.time()
                # 400ms digital-silence pad: EOU emission flickers right at the speech
                # boundary; padding stabilizes it at short (200-400ms) real tails —
                # measured on dock-recorded utterances (see stt-poc.md results log).
                padded = np.concatenate([buf, np.zeros(400 * 16, dtype=np.int16)])
                text = await loop.run_in_executor(POOL, decode, padded)
                ms = round((time.time() - t0) * 1000)
                words = text.replace("<EOU>", "").strip()
                print(f"decode {len(buf)/16000:.1f}s in {ms}ms → {text[:60]!r}", flush=True)
                if text.endswith("<EOU>") and words:
                    # bare <EOU> (no words) = the model heard nothing worth ending — never hint
                    # on it. NO one-shot latch: a premature EOU is disarmed station-side by the
                    # next voiced frame, and the LAST decode (full sentence + trailing silence)
                    # must still be able to hint — a latch here suppressed exactly that.
                    await ws.send(json.dumps({"type": "eou", "text": words, "decodeMs": ms}))
                elif words:
                    await ws.send(json.dumps({"type": "partial", "text": words, "decodeMs": ms}))
        else:
            try:
                j = json.loads(msg)
            except Exception:
                continue
            if j.get("type") == "reset":
                buf = np.zeros(0, dtype=np.int16)
                since_decode_ms = 0.0
                eou_sent = False


async def main():
    global model
    import nemo.collections.asr as nemo_asr
    print(f"loading {MODEL} (CPU)…", flush=True)
    t0 = time.time()
    model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL, map_location="cpu")
    print(f"  ready in {time.time()-t0:.0f}s", flush=True)
    import websockets
    async with websockets.serve(handle, "127.0.0.1", PORT, max_size=2**22):
        print(f"eou-sidecar on ws://127.0.0.1:{PORT}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
