#!/usr/bin/env python3
"""
Interactive console for the VLM monitoring benchmark — a CLI REPL that drives
watch.py's core: it keeps the webcam open and a background loop running, and
lets you change the instruction, models, output format, and cadence LIVE while
watching results stream. No browser needed (you asked for CLI-first; this is it).

    python3 console.py

Commands (type `help`):
    say <instruction>     set the monitoring instruction (live)
    models <a,b>          set the model list (live)
    json on|off           toggle structured JSON output
    every <seconds>       set the inference interval
    gate <n> | gate off   change-gate threshold (off = run every interval)
    640 on|off            also run the 640px recognition-still size
    once                  run a single frame right now and print results
    pause | resume        stop/start the background loop
    stats                 print the latency summary so far
    quit

This is intentionally a thin REPL over watch.py; all the capture/gate/infer
logic lives there so the CLI harness and this console can't drift.
"""

from __future__ import annotations

import threading
import time

import watch as w


class Runner:
    """Owns the camera + background inference loop; mutable config under a lock."""

    def __init__(self) -> None:
        self.instruction = w.DEFAULT_INSTRUCTION
        self.models = ["moondream", "qwen2.5vl:3b"]
        self.json = False
        self.interval = 2.0
        self.gate_threshold = 6.0
        self.gated = True
        self.also_640 = False

        self._cam = w.Camera()
        self._gate = w.ChangeGate(threshold=self.gate_threshold)
        self._stats = w.Stats()
        self._lock = threading.Lock()
        self._running = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # -- lifecycle -------------------------------------------------------- #
    def start(self) -> None:
        self._cam.open()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._running.set()

    def shutdown(self) -> None:
        self._stop.set()
        self._running.set()  # unblock the loop so it can see _stop
        if self._thread:
            self._thread.join(timeout=3)
        self._cam.close()

    # -- the loop --------------------------------------------------------- #
    def _loop(self) -> None:
        while not self._stop.is_set():
            self._running.wait()
            if self._stop.is_set():
                break
            t0 = time.perf_counter()
            try:
                self._tick()
            except Exception as e:  # noqa: BLE001 - never let the loop die
                print(f"\n[loop error] {e}")
            w._sleep_remaining(t0, self._snapshot()["interval"])

    def _snapshot(self) -> dict:
        with self._lock:
            return {
                "instruction": self.instruction,
                "models": list(self.models),
                "json": self.json,
                "interval": self.interval,
                "gated": self.gated,
                "also_640": self.also_640,
            }

    def _tick(self, force: bool = False) -> None:
        cfg = self._snapshot()
        frame = self._cam.read()  # 320×240
        if cfg["gated"] and not force:
            self._gate.threshold = self.gate_threshold
            changed, delta = self._gate.changed(frame)
            if not changed:
                return
        else:
            delta = 0.0

        sizes = [(w.STREAM_W, w.STREAM_H, "stream320")]
        if cfg["also_640"]:
            sizes.append((w.RECOG_MAX_EDGE, w.RECOG_MAX_EDGE * 3 // 4, "recog640"))

        ts = time.strftime("%H:%M:%S")
        print(f"\n[{ts}] Δ={delta:.1f}  \"{cfg['instruction']}\"")
        for sw, sh, tag in sizes:
            f = frame if (sw, sh) == (w.STREAM_W, w.STREAM_H) else self._cam.read(sw, sh)
            img = w.frame_to_jpeg_b64(f)
            for model in cfg["models"]:
                res = w.infer(model, img, cfg["instruction"], want_json=cfg["json"])
                label = f"{model}@{tag}"
                self._stats.add(label, res.latency_ms)
                body = res.text if res.ok else f"ERROR {res.error}"
                print(f"    {label:<28} {res.latency_ms:7.0f}ms  {body}")
        print("> ", end="", flush=True)

    # -- mutations -------------------------------------------------------- #
    def set(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def once(self) -> None:
        self._tick(force=True)

    def pause(self) -> None:
        self._running.clear()

    def resume(self) -> None:
        self._running.set()

    def stats(self) -> str:
        return self._stats.summary()


HELP = __doc__.split("Commands (type `help`):")[1].split('This is intentionally')[0].rstrip()


def repl() -> int:
    if not w.ollama_up():
        print("Ollama is not running. Start it:  ollama serve &")
        return 1

    r = Runner()
    have = w.installed_models()
    missing = [m for m in r.models if m not in have and f"{m}:latest" not in have]
    if missing:
        print("Heads up — not pulled yet: " + ", ".join(missing))
        print("  " + "  ".join(f"ollama pull {m}" for m in missing))

    print("VLM watch console. Type `help` for commands, `quit` to exit.")
    print(f"models={r.models} instruction=\"{r.instruction}\" json={r.json} every={r.interval}s")
    try:
        r.start()
    except Exception as e:  # noqa: BLE001
        print(f"Camera failed to open: {e}")
        return 1

    try:
        while True:
            try:
                line = input("> ").strip()
            except EOFError:
                break
            if not line:
                continue
            cmd, _, arg = line.partition(" ")
            cmd, arg = cmd.lower(), arg.strip()

            if cmd in ("quit", "exit", "q"):
                break
            elif cmd == "help":
                print("Commands (type `help`):" + HELP)
            elif cmd == "say" and arg:
                r.set(instruction=arg)
                print(f"instruction = \"{arg}\"")
            elif cmd == "models" and arg:
                ms = [m.strip() for m in arg.split(",") if m.strip()]
                r.set(models=ms)
                print(f"models = {ms}")
            elif cmd == "json":
                r.set(json=(arg == "on"))
                print(f"json = {arg == 'on'}")
            elif cmd == "every" and arg:
                try:
                    r.set(interval=float(arg))
                    print(f"interval = {float(arg)}s")
                except ValueError:
                    print("usage: every <seconds>")
            elif cmd == "gate":
                if arg == "off":
                    r.set(gated=False)
                    print("gate = off (every interval)")
                else:
                    try:
                        r.gate_threshold = float(arg)
                        r.set(gated=True)
                        print(f"gate = {float(arg)}")
                    except ValueError:
                        print("usage: gate <n> | gate off")
            elif cmd == "640":
                r.set(also_640=(arg == "on"))
                print(f"640 = {arg == 'on'}")
            elif cmd == "once":
                r.once()
            elif cmd == "pause":
                r.pause()
                print("paused")
            elif cmd == "resume":
                r.resume()
                print("resumed")
            elif cmd == "stats":
                print(r.stats())
            else:
                print("unknown command; type `help`")
    except KeyboardInterrupt:
        pass
    finally:
        print("\n" + r.stats())
        r.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(repl())
