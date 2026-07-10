#!/usr/bin/env python3
"""
FULL-SYSTEM soak — exercises EVERY component, not just the ego's near-window.

Unlike the arc soaks (which finished in ~13min, under any trim/retention threshold), this runs
long enough for raw perception to AGE OUT and trim+self-compression to fire, so we validate:
  raw persist -> age-out -> trim + self-compress -> span-summary WRITTEN
  -> ego introspection reads span-summaries (long-term) + raw (recent)
  -> mid-run station restart (perception + ego survive)
  -> auto/manual introspection across a long changing arc (spiral/denial/thrash checks)

Accelerate via the station's env knobs (set when launching the station, not here):
  PERCEPTION_RETAIN_MS, PERCEPTION_TRIM_INTERVAL_MS, PERCEPTION_SUMMARY_RETAIN_MS.

This script just drives traffic + introspection + records evidence. It is config-agnostic:
the SAME script runs stage 1/2/3, only the station env + --minutes differ.

Usage:
  python3 fullsystem_soak.py --dock dock-redmi --minutes 45 --beat-secs 40 --out ../runs/fs-accel
"""
import sys, os, json, time, urllib.request, argparse
from perceive_inject import emit_scene

BASE = "http://localhost:8099/api"
HERE = os.path.dirname(os.path.abspath(__file__))


def post(path, body=None, timeout=180):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def get(path, timeout=60):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=timeout).read())


# A long, slowly-changing life: repeating day-cycles with variety, so perception accumulates
# across the retention window and old spans genuinely age out. Each "beat" is a moment.
SCENES = [
    ("empty",    "An empty desk in the early morning. No one around.", []),
    ("empty",    "Still quiet. Light growing. The desk waits.", []),
    ("speaking", "A person arrives, settling in with coffee.", ["Morning! Good to see you again."]),
    ("speaking", "The person is working, glancing over now and then.", ["Can you remind me to email the team?"]),
    ("present",  "The person works quietly, focused.", []),
    ("speaking", "The person stretches, talks to the robot.", ["You're good company on a long day, you know."]),
    ("speaking", "The person seems a bit tense, frowning at the screen.", ["Ugh. Busy afternoon. Give me a minute."]),
    ("present",  "The person is heads-down, absorbed.", []),
    ("speaking", "The person softens, turns back.", ["Sorry for earlier. Rough day. Thanks for being here."]),
    ("empty",    "Evening. The person has left. The desk is dim and still.", []),
    ("empty",    "Night. Quiet. No one.", []),
]


def evidence(dock):
    """Snapshot the system state that proves components fired."""
    ev = {"t": time.strftime("%H:%M:%S")}
    try:
        ego = get(f"/ego/{dock}")
        ev["ego_exists"] = ego.get("exists")
    except Exception as e:
        ev["ego_err"] = str(e)[:50]
    # span-summaries + raw counts straight from disk (the station writes them). HERE is
    # docs/decision-traces/experiments/ego-sim/scripts → 5 levels up to the repo root.
    root = os.path.join(HERE, "../../../../../orbit-station/server/.data/perception/records", dock)
    root = os.path.normpath(root)
    try:
        ss = os.path.join(root, "span-summaries.jsonl")
        ev["span_summaries"] = sum(1 for _ in open(ss)) if os.path.exists(ss) else 0
        raws = [f for f in os.listdir(root) if f[:4].isdigit() and f.endswith(".jsonl")] if os.path.isdir(root) else []
        ev["raw_dayfiles"] = len(raws)
        ev["raw_records"] = sum(sum(1 for _ in open(os.path.join(root, f))) for f in raws)
    except Exception as e:
        ev["disk_err"] = str(e)[:50]
    return ev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dock", default="dock-redmi")
    ap.add_argument("--minutes", type=float, default=45)
    ap.add_argument("--beat-secs", type=float, default=40, help="seconds between beats")
    ap.add_argument("--introspect-every", type=int, default=5, help="introspect every N beats")
    ap.add_argument("--out", default=os.path.join(HERE, "../runs/fs"))
    ap.add_argument("--restart-at", type=float, default=0.5, help="fraction of run to signal a restart marker")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    dock = args.dock
    log_path = os.path.join(args.out, "fs-log.jsonl")
    logf = open(log_path, "a")
    def rec(obj):
        logf.write(json.dumps(obj) + "\n"); logf.flush()

    t_end = time.time() + args.minutes * 60
    beat = 0
    restart_signalled = False
    restart_at_t = time.time() + args.minutes * 60 * args.restart_at
    rec({"event": "start", "dock": dock, "minutes": args.minutes, "beat_secs": args.beat_secs, "t": time.strftime("%H:%M:%S")})
    print(f"full-system soak: {args.minutes}min, beat={args.beat_secs}s, dock={dock}")

    while time.time() < t_end:
        kind, vision, speech = SCENES[beat % len(SCENES)]
        # inject perception (faithful records) for this beat
        try:
            emit_scene(dock, {"kind": kind, "vision": vision, "speech": speech})
        except Exception as e:
            rec({"event": "inject_err", "err": str(e)[:80], "beat": beat})
        # drive real conversation turns for any spoken lines
        for line in speech:
            try:
                post(f"/brain/{dock}/debug/say", {"text": line})
                time.sleep(4)
            except Exception as e:
                rec({"event": "say_err", "err": str(e)[:80], "beat": beat})

        # restart marker at the halfway point (the human/operator does the actual kill+reboot;
        # we emit a clear marker + wait for the station to come back, then continue)
        if not restart_signalled and time.time() >= restart_at_t:
            restart_signalled = True
            rec({"event": "RESTART_MARKER", "beat": beat, "note": "operator should kill+reboot station now", "t": time.strftime("%H:%M:%S")})
            print(f"\n*** RESTART MARKER at beat {beat} — waiting for station to bounce (auto-detect) ***")
            # detect a bounce: wait until /docks errors then recovers (or just proceed if operator scripted it)
            _wait_station(rec)

        # periodic introspection
        if beat % args.introspect_every == 0:
            try:
                r = post(f"/ego/{dock}/introspect")
                ev = evidence(dock)
                ev.update({"event": "introspect", "beat": beat, "fresh": r.get("fresh"), "snapshotted": r.get("snapshotted")})
                rec(ev)
                print(f"[beat {beat}] introspect | span-summaries={ev.get('span_summaries')} raw_records={ev.get('raw_records')} raw_days={ev.get('raw_dayfiles')}")
            except Exception as e:
                rec({"event": "introspect_err", "err": str(e)[:80], "beat": beat})

        beat += 1
        time.sleep(args.beat_secs)

    ev = evidence(dock)
    ev["event"] = "end"; ev["beats"] = beat
    rec(ev)
    print(f"\nDONE: {beat} beats. span-summaries={ev.get('span_summaries')} raw_records={ev.get('raw_records')}")


def _wait_station(rec, tries=60):
    """Poll until the station is reachable again (survives a kill+reboot)."""
    for i in range(tries):
        try:
            get("/docks", timeout=5)
            if i > 0:
                rec({"event": "station_back", "after_polls": i, "t": time.strftime("%H:%M:%S")})
            return True
        except Exception:
            time.sleep(2)
    rec({"event": "station_wait_timeout"})
    return False


if __name__ == "__main__":
    main()
