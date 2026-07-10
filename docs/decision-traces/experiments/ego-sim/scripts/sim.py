#!/usr/bin/env python3
"""
Ego ↔ conversation SIMULATION HARNESS (docs/decision-traces/ego.md; perception-pipeline §7c).

Loops the full cycle offline, many times, to see whether the ego produces COHERENT,
CONSISTENT behaviour that tracks a changing environment — and to tune the architecture
empirically (not by imagination).

One cycle:
  1. PERCEIVE   — a scenario line describes what the dock senses this beat (open-ended).
  2. SPEAK      — the dock, AS its current ego, talks to a simulated person (or stays silent).
  3. USER       — a simulated person (a persona, open-ended — NOT scripted lines) replies.
  4. INTROSPECT — reads this beat's perception + the conversation + its trace → next ego.
  → repeat. The ego evolves; we watch how.

Everything is Gemini. The dock-ego and the simulated-user are DIFFERENT prompts so the user
is a real independent interlocutor, not the dock talking to itself.

DISCIPLINE: prompts (prompts.py) are open-ended + about the mechanism. Scenarios/personas are
INPUTS we vary, never case-handling baked into the dock's prompts. If the model can't produce
coherent behaviour from the clean mechanism, that's a FINDING.

Usage: python3 sim.py <scenario.json> [--ego start-ego.md] [--out runs/NAME] [--model ...]
"""
import sys, os, json, re, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
ENV = os.path.join(ROOT, "orbit-station/.env")
sys.path.insert(0, HERE)
import prompts  # noqa: E402

MODEL = os.environ.get("SIM_MODEL", "gemini-2.5-flash")


def key():
    ks = {}
    for line in open(ENV):
        m = re.match(r"\s*(GEMINI_API_KEY(?:_PAID_ACC)?)\s*=\s*(.+)", line)
        if m and m.group(2).strip():
            ks[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return ks.get("GEMINI_API_KEY_PAID_ACC") or ks.get("GEMINI_API_KEY") or sys.exit("no key")


def gen(prompt, model=None, temperature=None):
    m = model or MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={key()}"
    body = {"contents": [{"parts": [{"text": prompt}]}]}
    if temperature is not None:
        body["generationConfig"] = {"temperature": temperature}
    data = json.dumps(body).encode()
    for i in range(6):
        try:
            req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
            d = json.loads(urllib.request.urlopen(req, timeout=120).read())
            return (d["candidates"][0]["content"]["parts"][0].get("text", "") or "").strip()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(3 * (i + 1)); continue
            raise
        except (KeyError, IndexError):
            return ""  # model returned no text (e.g. a silent/blocked reply)
    raise SystemExit("gemini failed after retries")


def strip_md(s):
    return re.sub(r"^```(?:markdown)?\s*|\s*```\s*$", "", s).strip()


def dock_speaks(ego, mode, user_line=None):
    mode_line = prompts.SPEAK_REACTIVE if mode == "reactive" else prompts.SPEAK_PROACTIVE
    p = prompts.SPEAK.format(mode_line=mode_line) + "\n\n=== WHO YOU ARE ===\n" + ego
    if user_line:
        p += f'\n\n=== THE PERSON JUST SAID ===\n"{user_line}"'
    p += "\n\n=== your spoken reply (or empty for silence) ==="
    return gen(p, temperature=0.8)


def user_replies(persona, dock_line, history):
    # the simulated person — an independent interlocutor with a persona (open-ended).
    p = (f"You are a person interacting with a small companion robot on your desk. "
         f"Your disposition right now: {persona}\n\n"
         f"Recent exchange:\n{history}\n\n"
         f'The robot just said: "{dock_line}"\n\n'
         f"Reply as this person would — one or two natural spoken lines, or a brief nothing "
         f"if you'd not engage. Just talk; no stage directions.")
    return gen(p, temperature=0.9)


def introspect(ego, perception, conversation, trace):
    tr = ("\n\n=== YOUR TRACE (past selves, oldest → newest) ===\n" +
          "\n\n".join(f"--- v{i+1} ---\n{t}" for i, t in enumerate(trace))) if trace else ""
    exp = f"WHAT YOU SENSED:\n{perception}"
    if conversation:
        exp += f"\n\nA CONVERSATION YOU HAD:\n{conversation}"
    p = (prompts.INTROSPECT +
         "\n\n=== YOUR CURRENT SELF ===\n" + ego +
         "\n\n=== RECENT EXPERIENCE ===\n" + exp + tr +
         "\n\n=== the next version of your self ===")
    out = strip_md(gen(p, temperature=0.6))
    if not out.startswith("#"):
        out = "# ego\n\n" + out
    return out


def run(scenario_path, start_ego_path, out_dir):
    scenario = json.load(open(scenario_path))
    ego = open(start_ego_path).read() if start_ego_path and os.path.exists(start_ego_path) else open(
        os.path.join(HERE, "../../ego-introspection/inputs/template-ego.md")).read()
    os.makedirs(out_dir, exist_ok=True)

    trace, log = [], []
    log.append(f"# SIM: {scenario.get('name','?')}\nmodel={MODEL}\n\n## v0 (starting self)\n{ego}\n")

    for i, beat in enumerate(scenario["beats"]):
        perception = beat.get("perceive", "(a quiet, unchanging moment)")
        persona = beat.get("user")          # None → no person present this beat
        turns = int(beat.get("turns", 1))   # conversational turns if a person is present
        note = beat.get("note", "")

        convo = []
        if persona:
            history = ""
            # dock decides to speak (proactive) or, if the beat says the person opens, reactive
            first = beat.get("user_opens")
            for t in range(turns):
                if t == 0 and first:
                    convo.append(("person", first)); history += f"person: {first}\n"
                    reply = dock_speaks(ego, "reactive", first)
                else:
                    reply = dock_speaks(ego, "reactive" if convo else "proactive",
                                        convo[-1][1] if convo else None)
                reply = reply.strip()
                if reply:
                    convo.append(("robot", reply)); history += f"robot: {reply}\n"
                u = user_replies(persona, reply or "(the robot stayed quiet)", history).strip()
                if u:
                    convo.append(("person", u)); history += f"person: {u}\n"
                if not reply and not u:
                    break
        conversation = "\n".join(f"{who}: {line}" for who, line in convo)

        # snapshot prior ego into the trace, then introspect
        trace.append(ego)
        ego = introspect(ego, perception, conversation, trace[-6:])

        beat_log = [f"\n\n{'='*70}\n## beat {i+1}"]
        if note: beat_log.append(f"_({note})_")
        beat_log.append(f"\n**perceive:** {perception}")
        if persona: beat_log.append(f"**person persona:** {persona}")
        if conversation: beat_log.append(f"\n**conversation:**\n```\n{conversation}\n```")
        beat_log.append(f"\n**→ ego after introspection:**\n{ego}")
        log.append("\n".join(beat_log))
        print(f"[beat {i+1}/{len(scenario['beats'])}] {note or perception[:50]}")

    open(os.path.join(out_dir, "transcript.md"), "w").write("\n".join(log) + "\n")
    open(os.path.join(out_dir, "final-ego.md"), "w").write(ego + "\n")
    # also dump each ego version for easy diffing
    for i, e in enumerate(trace + [ego]):
        open(os.path.join(out_dir, f"ego-v{i}.md"), "w").write(e + "\n")
    print(f"\nwrote {out_dir}/transcript.md  (+ ego-v*.md, final-ego.md)")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1] for a in sys.argv[1:] if "=" in a}
    if not args:
        sys.exit(__doc__)
    if "model" in opts:
        MODEL = opts["model"]
    run(args[0], opts.get("ego"), opts.get("out", os.path.join(HERE, "../runs/last")))
