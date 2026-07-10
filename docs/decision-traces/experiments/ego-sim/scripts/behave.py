#!/usr/bin/env python3
"""
Interactive BEHAVIORAL driver for the ego. Drive the real station step-by-step and see the ego
respond immediately — no waiting on hourly/idle timelines. Every action hits real code paths
(perception records, the brain turn path, introspection); the timelines are bypassed by calling
introspection directly and (optionally) running the station with fast compression config.

Run the station first (fast config recommended, e.g.):
  PERCEPTION_RETAIN_MS=60000 PERCEPTION_TRIM_INTERVAL_MS=20000 PERCEPTION_BUCKET_MINUTES=1 npm run dev

Then:  python3 behave.py            # interactive REPL
   or:  python3 behave.py scenario.txt   # run a scripted scenario (one command per line)

COMMANDS (each acts NOW, then you can `ego` to see the effect):
  see <text>            inject a VISION observation (what the camera sees)
  hear <text>           inject SPEECH heard in the room (overheard — NOT addressed to the dock)
  say <text>            a person speaks TO the dock (drives a real brain turn; the dock may reply)
  here <n>              inject IDENTITY: n people present (0 = "no one")
  gap <minutes>         simulate a downtime gap (no records for N min — offline, not empty room)
  introspect [trigger]  run one introspection NOW (default trigger 'manual'); bypasses the gap
  ego [section]         print the current ego (or one section: who/story/tension/why/anticip)
  trace                 list the ego trace snapshots (the history of becoming)
  facts [query]         show stored memory facts (optionally filtered)
  reset                 wipe this dock's ego + perception (fresh self)
  wait <seconds>        sleep (let records age / auto-things fire)
  note <text>           just print a label (for readable scenario logs)
  quit
"""
import sys, os, json, time, urllib.request, re
from perceive_inject import emit_scene, _append, vision as mk_vision, speech as mk_speech, identity as mk_identity

BASE = "http://localhost:8099/api"
DOCK = os.environ.get("BEHAVE_DOCK", "dock-redmi")


def post(path, body=None, timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(body or {}).encode(),
                                 headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def get(path, timeout=60):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=timeout).read())


def show_ego(section=None):
    try:
        ego = get(f"/ego/{DOCK}").get("ego", "")
    except Exception as e:
        print(f"  (ego read failed: {e})"); return
    aliases = {"who": "who I am", "story": "what.s going on", "tension": "where it doesn.t add up",
               "why": "why I.m here", "anticip": "what I expect"}
    if section:
        name = aliases.get(section, section)
        m = re.search(rf"## {name}(.*?)(?=\n## |\Z)", ego, re.S)
        print(f"  [{section}] {re.sub(chr(92)+'s+', ' ', (m.group(1).strip() if m else '?'))[:400]}")
    else:
        for key, name in aliases.items():
            m = re.search(rf"## {name}(.*?)(?=\n## |\Z)", ego, re.S)
            if m:
                print(f"  {key:8}: {re.sub(chr(92)+'s+', ' ', m.group(1).strip())[:180]}")


def do(cmd):
    cmd = cmd.strip()
    if not cmd or cmd.startswith("#"):
        if cmd.startswith("#"): print(cmd)
        return True
    parts = cmd.split(None, 1)
    op = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""

    if op in ("quit", "exit", "q"):
        return False
    elif op == "see":
        _append(DOCK, mk_vision(DOCK, arg)); print(f"  👁  saw: {arg}")
    elif op == "hear":
        _append(DOCK, mk_speech(DOCK, arg, addressed=False)); print(f"  🎙  heard (overheard, not to dock): {arg}")
    elif op == "say":
        try:
            post(f"/brain/{DOCK}/debug/say", {"text": arg})
            print(f"  🗣  person said TO dock: {arg}  (turn running…)")
            time.sleep(6)
        except Exception as e:
            print(f"  (say failed: {e})")
    elif op == "here":
        n = int(arg or "1")
        _append(DOCK, mk_identity(DOCK, "no one" if n == 0 else f"{n} person" if n == 1 else f"{n} people"))
        print(f"  👤 identity: {'no one' if n==0 else str(n)+' present'}")
    elif op == "gap":
        mins = float(arg or "60")
        print(f"  ⏸  simulating {mins}min downtime gap (no records written — offline)")
        # nothing to inject; the ABSENCE of records IS the gap. Advisory only.
        print("     (next records will be >gap apart → perceptionSince labels it offline)")
    elif op == "introspect":
        trig = arg or "manual"
        try:
            r = post(f"/ego/{DOCK}/introspect", {"trigger": trig} if arg else {})
            print(f"  🪞 introspected (trigger={trig}, fresh={r.get('fresh')}, snapshotted={r.get('snapshotted')})")
        except Exception as e:
            print(f"  (introspect failed: {e})")
    elif op == "ego":
        show_ego(arg or None)
    elif op == "trace":
        try:
            entries = get(f"/ego/{DOCK}/trace").get("entries", [])
            print(f"  trace: {len(entries)} snapshot(s)")
            for e in entries[:10]: print(f"    - {e.get('ts')}")
        except Exception as e:
            print(f"  (trace failed: {e})")
    elif op == "facts":
        try:
            q = f"&query={urllib.request.quote(arg)}" if arg else ""
            d = get(f"/perception/memory?dock={DOCK}&limit=15{q}")
            print(f"  facts: {d.get('count')} total")
            for r in d.get("memories", [])[:12]:
                print(f"    [{r.get('confidence')}] {r.get('subject','')}: {r.get('claim','')[:60]}")
        except Exception as e:
            print(f"  (facts failed: {e})")
    elif op == "reset":
        import shutil
        for p in [f"orbit-station/server/.data/ego/{DOCK}",
                  f"orbit-station/server/.data/perception/records/{DOCK}"]:
            ap = os.path.join(os.path.dirname(__file__), "../../../../../", p)
            shutil.rmtree(os.path.normpath(ap), ignore_errors=True)
        print(f"  ♻️  reset {DOCK}: ego + perception wiped (fresh self)")
    elif op == "wait":
        secs = float(arg or "5"); print(f"  … waiting {secs}s"); time.sleep(secs)
    elif op == "note":
        print(f"  — {arg}")
    else:
        print(f"  ? unknown command: {op}  (try: see/hear/say/here/introspect/ego/facts/trace/reset/wait/quit)")
    return True


def main():
    print(f"behavioral driver → dock={DOCK}  (station: {BASE})")
    try:
        get("/docks")
    except Exception:
        print("  ⚠ station not reachable — start it first (npm run dev)."); return
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        print(f"running scenario: {sys.argv[1]}\n")
        for line in open(sys.argv[1]):
            line = line.rstrip("\n")
            if line.strip():
                print(f"> {line}")
            if not do(line):
                break
    else:
        print("interactive — type commands (help: see the file header). 'quit' to exit.\n")
        while True:
            try:
                line = input("behave> ")
            except (EOFError, KeyboardInterrupt):
                print(); break
            if not do(line):
                break


if __name__ == "__main__":
    main()
