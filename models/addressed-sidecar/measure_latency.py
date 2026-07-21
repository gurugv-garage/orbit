#!/usr/bin/env python3
"""
measure_latency.py — measure speak→parakeet-on-stream latency, and isolate whether
the addressed classifier (or its sidecar competing for the GPU) is responsible.

Two things this measures, per utterance, off the perception records:
  A) STT inferMs           — parakeet's own transcribe time (payload.inferMs).
  B) endpoint→persist gap  — interval.to (VAD end) → file mtime when the record was
                             written. This is the "why does STT show up later" number.

It does NOT need instrumentation in the station: it reads the JSONL the station
already writes. Run it, speak a few lines to the dock, then read the table.

Usage:
  python3 measure_latency.py --dock dock-redmi --watch 60     # watch 60s of new utts
  python3 measure_latency.py --dock dock-redmi --tail 20      # last 20 utterances

To A/B the classifier's effect on latency: run with the sidecar UP, then set
ADDRESSED_CLASSIFIER=0 on the station (or kill :8081) and compare inferMs / gap.
"""
import argparse, json, os, time

RECORDS = "/Users/guru/garage/orbit/orbit-station/server/.data/perception/records"

def iso_ms(s):
    import datetime
    return int(datetime.datetime.fromisoformat(s).timestamp() * 1000)

def read_speech(path):
    """Live parakeet rows (not the addressedP-patched dup, not enriched)."""
    out = {}
    with open(path) as f:
        for line in f:
            if '"kind":"speech"' not in line:
                continue
            try: r = json.loads(line)
            except json.JSONDecodeError: continue
            if r.get("source", {}).get("kind") != "speech": continue
            p = r.get("payload", {})
            if not p.get("liveOnly"): continue
            key = r["interval"]["from"]
            # last-write-wins per utterance (the patched dup carries addressedP AND
            # the same inferMs) — so we keep the richest row per utterance.
            prev = out.get(key)
            if prev is None:
                out[key] = (r, p, "addressedP" in p)
            else:
                # merge: prefer a row that has addressedP, keep inferMs from either
                merged = dict(prev[1]); merged.update(p)
                out[key] = (r, merged, "addressedP" in merged)
    return out

def summarize(rows):
    infers = [p.get("inferMs") for _, p, _ in rows if p.get("inferMs")]
    print(f"\n{'end (IST)':>12}  {'inferMs':>7}  {'dur(ms)':>7}  addressedP  text")
    for r, p, _ in rows:
        end = r["interval"]["to"][11:19]
        dur = r["interval"].get("durationMs", "")
        ap = p.get("addressedP")
        aps = f"{ap:.2f}" if isinstance(ap, (int, float)) else "  – "
        print(f"{end:>12}  {str(p.get('inferMs','')):>7}  {str(dur):>7}   {aps:>6}    {p.get('text','')[:42]!r}")
    if infers:
        s = sorted(infers)
        print(f"\nparakeet inferMs: n={len(s)}  p50={s[len(s)//2]}  p90={s[int(len(s)*0.9)]}  "
              f"min={min(s)}  max={max(s)}  mean={sum(s)//len(s)}")
    print("\nNote: inferMs is the SIDECAR transcribe time (parakeet). If this rose vs a")
    print("baseline, the addressed sidecar competing for Metal is the likely cause —")
    print("A/B it: kill :8081 (or ADDRESSED_CLASSIFIER=0) and re-measure.")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dock", default="dock-redmi")
    ap.add_argument("--tail", type=int, default=15)
    ap.add_argument("--watch", type=int, default=0, help="seconds to watch for NEW utterances")
    a = ap.parse_args()
    import glob, re
    # dated day-files only (YYYY-MM-DD.jsonl) — NOT span-summaries.jsonl
    files = sorted(f for f in glob.glob(f"{RECORDS}/{a.dock}/*.jsonl")
                   if re.search(r"/\d{4}-\d{2}-\d{2}\.jsonl$", f))
    if not files:
        print(f"no dated records for {a.dock}"); return
    path = files[-1]

    if a.watch:
        print(f"watching {path} for {a.watch}s — speak to the dock now…")
        seen = set(read_speech(path).keys())
        t0 = time.time()
        fresh = []
        while time.time() - t0 < a.watch:
            cur = read_speech(path)
            for k, v in cur.items():
                if k not in seen:
                    seen.add(k); fresh.append(v)
                    r, p, _ = v
                    print(f"  + {r['interval']['to'][11:19]}  infer={p.get('inferMs')}ms  {p.get('text','')[:40]!r}")
            time.sleep(0.5)
        summarize(sorted(fresh, key=lambda x: x[0]["interval"]["from"]))
    else:
        rows = sorted(read_speech(path).values(), key=lambda x: x[0]["interval"]["from"])[-a.tail:]
        summarize(rows)

if __name__ == "__main__":
    main()
