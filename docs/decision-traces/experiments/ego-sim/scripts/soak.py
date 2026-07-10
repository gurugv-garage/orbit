#!/usr/bin/env python3
"""
Accelerated IN-STATION soak. Drives the REAL running station over a long scripted arc so the
ego evolves through the actual pipeline (durable perception, checkpoint read,
conversation-into-introspection, the real brain). Not "real people", but every real code path,
unattended, over many cycles.

Each BEAT:
  0. inject PERCEPTION (perceive_inject.py) — faithful vision/speech/identity records into the
     durable feed, so what the ego *sensed* (empty room / someone present / someone speaking)
     changes with the arc, not just the conversation. Records are byte-shaped from real past
     data (records the live pipeline genuinely produces).
  1. inject a conversation via the real brain path (POST /brain/:dock/debug/say) — the person
     speaks, the real brain (coloured by the ego) replies; optionally a follow-up.
  2. trigger an introspection (POST /ego/:dock/introspect) — reads the span + conversations.
  3. record the ego snapshot.

A beat's "person" turns are scripted to simulate a changing life over the arc (lonely →
someone arrives → warms → a hard moment → resolution → routine), to see whether the self
tracks a changing environment coherently, at a believable pace, without runaway.

Usage: python3 soak.py [dock] [arc.json] [--out runs/soak]
"""
import sys, os, json, time, urllib.request, re
from perceive_inject import emit_scene

BASE = "http://localhost:8099/api"
HERE = os.path.dirname(os.path.abspath(__file__))
DOCK = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "dock-redmi"
ARC = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else os.path.join(HERE, "../scenarios/life-arc.json")
OUT = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--out=")), os.path.join(HERE, "../runs/soak"))


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=60).read())


def who_am_i(ego):
    m = re.search(r"## who I am(.*?)(?=\n## )", ego, re.S)
    return re.sub(r"\s+", " ", (m.group(1).strip() if m else "?"))[:200]


def tension(ego):
    m = re.search(r"## where it doesn.t add up(.*?)(?=\n## )", ego, re.S)
    return re.sub(r"\s+", " ", (m.group(1).strip() if m else "?"))[:200]


def main():
    arc = json.load(open(ARC))
    os.makedirs(OUT, exist_ok=True)
    log = [f"# SOAK (in-station): {arc.get('name','?')}\ndock={DOCK}\n"]
    print(f"soak: {arc.get('name')}  ({len(arc['beats'])} beats)")

    for i, beat in enumerate(arc["beats"]):
        note = beat.get("note", "")
        # 0. inject PERCEPTION for this beat (what the ego SENSED) — faithful records into the
        #    durable feed. Default scene inferred from the beat: speaking if there are lines,
        #    else empty; an explicit `scene` in the beat overrides.
        scene = beat.get("scene")
        if scene is None:
            scene = {"kind": "speaking" if beat.get("person") else "empty"}
        # mirror the person's spoken lines into the speech stream too (heard, not just "said")
        if beat.get("person") and "speech" not in scene:
            scene = {**scene, "speech": beat["person"]}
        try:
            emit_scene(DOCK, scene)
        except Exception as e:
            print(f"  (perception inject failed: {str(e)[:60]})")
        # 1. inject the person's lines through the real brain (each drives a real turn)
        convo = []
        for line in beat.get("person", []):
            try:
                post(f"/brain/{DOCK}/debug/say", {"text": line})
                convo.append(("person", line))
                time.sleep(6)  # let the real turn run (brain reply lands in the session)
            except Exception as e:
                convo.append(("(inject failed)", str(e)[:60]))
        # 2. introspect (reads the conversation just had + perception span)
        try:
            r = post(f"/ego/{DOCK}/introspect", {})
            ego = r.get("ego", "")
        except Exception as e:
            ego = f"(introspect failed: {e})"
        # 3. record
        block = [f"\n{'='*70}\n## beat {i+1}: {note}"]
        block.append(f"*scene: {scene.get('kind','?')} — {scene.get('vision','')[:80]}*")
        if convo:
            block.append("**person said:**")
            for _, t in convo:
                block.append(f"  - {t[:120]}")
        block.append(f"\n**→ who I am:** {who_am_i(ego)}")
        block.append(f"**→ tension:** {tension(ego)}")
        log.append("\n".join(block))
        open(os.path.join(OUT, f"ego-{i+1:02d}.md"), "w").write(ego + "\n")
        print(f"[beat {i+1}/{len(arc['beats'])}] {note[:44]}")
        open(os.path.join(OUT, "soak-log.md"), "w").write("\n".join(log) + "\n")
        time.sleep(2)

    print(f"\nwrote {OUT}/soak-log.md  (+ ego-NN.md per beat)")


if __name__ == "__main__":
    main()
