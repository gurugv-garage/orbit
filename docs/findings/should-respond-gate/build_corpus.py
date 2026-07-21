#!/usr/bin/env python3
"""
Build the coherence benchmark corpus.

For each real STT utterance from the perception speech stream, reconstruct the
conversation context it landed in (the recent brain-session transcript window
around its timestamp) and attach whatever ground-truth signals we have offline.

Output: coherence_corpus.jsonl — one row per utterance:
  {
    ts_ms, dock, text, confTier, confidence, voice,      # the utterance
    context: [{role, text, ts_ms}, ...],                 # recent transcript before it
    gt: { ran_turn: bool|None, self_ok: bool }           # offline ground-truth signals
  }

Purely static — reads .data on disk, no station required.
"""
import json, glob, os, sys
from datetime import datetime

ROOT = "/Users/guru/garage/orbit/orbit-station/server/.data"
DOCK = sys.argv[1] if len(sys.argv) > 1 else "dock-redmi"
CONTEXT_WINDOW_MS = 4 * 60 * 1000   # look back 4 min for conversation context
MAX_CONTEXT_MSGS = 8

def iso_to_ms(s):
    # "2026-07-21T06:30:30.960+05:30"
    return int(datetime.fromisoformat(s).timestamp() * 1000)

def load_speech(dock):
    """All parakeet speech utterances for the dock, across day files, dedup last-wins."""
    rows = {}
    for f in sorted(glob.glob(f"{ROOT}/perception/records/{dock}/*.jsonl")):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line or '"kind":"speech"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("source", {}).get("kind") != "speech":
                    continue
                p = r.get("payload", {})
                text = (p.get("text") or "").strip()
                if not text:
                    continue
                key = (r["interval"]["from"], r["source"]["id"])
                rows[key] = {
                    "ts_ms": iso_to_ms(r["interval"]["from"]),
                    "dock": dock,
                    "text": text,
                    "confTier": p.get("confTier"),
                    "confidence": p.get("confidence"),
                    "voice": (p.get("voice") or {}).get("name"),
                }
    return sorted(rows.values(), key=lambda x: x["ts_ms"])

def load_sessions(dock):
    """Load every session transcript as a flat, time-sorted list of {role,text,ts_ms}."""
    msgs = []
    for f in glob.glob(f"{ROOT}/brain/{dock}/s-*.json"):
        try:
            arr = json.load(open(f))
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(arr, list):
            continue
        for m in arr:
            role = m.get("role")
            ts = m.get("timestamp")
            if role not in ("user", "assistant") or not ts:
                continue
            # flatten content blocks to text
            txt = []
            for b in m.get("content", []):
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                    txt.append(b["text"])
            txt = " ".join(txt).strip()
            if not txt:
                continue
            msgs.append({"role": role, "text": txt, "ts_ms": int(ts)})
    return sorted(msgs, key=lambda x: x["ts_ms"])

def context_for(utt_ts, msgs):
    """Recent transcript messages strictly before this utterance, within the window."""
    lo = utt_ts - CONTEXT_WINDOW_MS
    ctx = [m for m in msgs if lo <= m["ts_ms"] < utt_ts]
    return ctx[-MAX_CONTEXT_MSGS:]

def ran_turn_near(utt_ts, msgs, tol_ms=8000):
    """Ground-truth 'addressed' proxy: did a user->assistant turn fire right after?
       If an assistant message appears within tol_ms after the utterance, the dock
       responded => effectively addressed. None if no session data near this time."""
    near = [m for m in msgs if abs(m["ts_ms"] - utt_ts) < 5 * 60 * 1000]
    if not near:
        return None
    return any(m["role"] == "assistant" and 0 <= m["ts_ms"] - utt_ts <= tol_ms for m in near)

def main():
    speech = load_speech(DOCK)
    msgs = load_sessions(DOCK)
    out_path = os.path.join(os.path.dirname(__file__), "coherence_corpus.jsonl")
    n = 0
    with open(out_path, "w") as out:
        for u in speech:
            ctx = context_for(u["ts_ms"], msgs)
            row = {
                **u,
                "context": ctx,
                "gt": {
                    "ran_turn": ran_turn_near(u["ts_ms"], msgs),
                    "self_ok": u["confTier"] == "good",
                },
            }
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    with_ctx = sum(1 for u in speech if context_for(u["ts_ms"], msgs))
    print(f"dock={DOCK}")
    print(f"utterances: {n}")
    print(f"  with conversation context: {with_ctx}")
    print(f"  session messages loaded: {len(msgs)}")
    print(f"wrote {out_path}")

if __name__ == "__main__":
    main()
