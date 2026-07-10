#!/usr/bin/env python3
"""
Extract a real "experience arc" for a dock from the persisted station data, as a clean
chronological transcript — the input an introspection pass would read.

Sources (persisted, no running station needed):
  - brain sessions:  .data/brain/<dock>/s-*.json   (real interaction turns)
  - rolling summary:  .data/perception/last-summary.json  (latest perception meaning)

Output: inputs/experience-<dock>.txt  — a plain, deduped, readable transcript.

Usage: python3 extract-experience.py [dock] [max_turns]
"""
import json, glob, os, sys, re
from datetime import datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../.."))
DATA = os.path.join(ROOT, "orbit-station/server/.data")
DOCK = sys.argv[1] if len(sys.argv) > 1 else "dock-redmi"
MAX_TURNS = int(sys.argv[2]) if len(sys.argv) > 2 else 120
OUT = os.path.join(os.path.dirname(__file__), f"../inputs/experience-{DOCK}.txt")


# PUBLIC REPO: this pulls from real private session data. Scrub personal identifiers to
# placeholders before anything is written to disk, so the committed inputs carry no real
# names. Extend this map as needed for a given dock's data.
REDACT = {
    r"\bNikry\b": "Alex",
    r"\bCR\b": "the user",
}


def redact(s):
    for pat, rep in REDACT.items():
        s = re.sub(pat, rep, s)
    return s


def text_of(item):
    t = item.get("text") or item.get("content") or item.get("message") or ""
    if isinstance(t, list):
        t = " ".join(str(x.get("text", "") if isinstance(x, dict) else x) for x in t)
    return redact(re.sub(r"\s+", " ", str(t)).strip())


def collapse_repeats(lines):
    """The dock repeats near-identical lines (e.g. 'body offline') dozens of times.
    Collapse a run of the same role+similar text into one line + a (×N) count — this is
    itself a signal introspection cares about (a recurring, unresolved situation)."""
    out = []
    for role, txt in lines:
        key = (role, txt[:60].lower())
        if out and out[-1][2] == key:
            out[-1][3] += 1
        else:
            out.append([role, txt, key, 1])
    return [(r, t, n) for r, t, _, n in out]


def main():
    # newest sessions first, take turns until MAX_TURNS
    sessions = sorted(glob.glob(f"{DATA}/brain/{DOCK}/s-*.json"), key=os.path.getmtime, reverse=True)
    lines = []
    for sf in sessions:
        try:
            items = json.load(open(sf))
        except Exception:
            continue
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            role = it.get("role") or it.get("kind") or "?"
            txt = text_of(it)
            if not txt:
                continue
            # FILTER prompt-scaffolding: the station injects long system prompts as "user"
            # turns ("You are bored…", "Something JUST HAPPENED…", "[wake]…"). Those are the
            # ego's own machinery, NOT experience. Keep real user speech + the dock's own
            # replies + genuine events (task failures, reminders fired).
            if role == "user":
                # a real user utterance is short and not a bracketed directive / long coaching prompt
                if len(txt) > 220 or txt.lstrip().startswith("["):
                    # keep bracketed EVENTS (task failed/finished) — they are real experience
                    if not re.search(r"\b(failed|finished|update|came into view|wake)\b", txt[:80], re.I):
                        continue
                    # trim bracketed events to their gist
                    txt = re.sub(r"\s+", " ", txt)[:140]
            lines.append((role, txt))
        if len(lines) >= MAX_TURNS:
            break
    lines = lines[:MAX_TURNS]
    lines.reverse()  # chronological-ish (newest session, oldest-first within budget)

    collapsed = collapse_repeats(lines)

    parts = [f"# Experience arc — {DOCK}", f"# extracted {len(collapsed)} distinct lines from {len(sessions)} sessions", ""]

    # latest perception meaning (the rolling picture)
    try:
        ls = json.load(open(f"{DATA}/perception/last-summary.json"))
        v = ls.get(DOCK)
        if v and v.get("text"):
            parts += ["## latest perception (rolling summary)", v["text"].strip(), ""]
    except Exception:
        pass

    parts += ["## interaction history (oldest → newest, repeats collapsed)"]
    for role, txt, n in collapsed:
        tag = "USER" if role == "user" else ("ME" if role == "assistant" else role.upper())
        rep = f"  (×{n})" if n > 1 else ""
        parts.append(f"[{tag}] {txt}{rep}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write("\n".join(parts) + "\n")
    print(f"wrote {OUT}  ({len(collapsed)} lines)")


if __name__ == "__main__":
    main()
