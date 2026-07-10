#!/usr/bin/env python3
"""
Run one INTROSPECTION pass: (current ego + recent experience [+ trace]) → the next ego.
This is the experiment for ego.md §3.2 — does the introspection prompt produce a coherent,
evolving self?

Usage:
  python3 introspect.py <experience.txt> [current-ego.md] [--out out.md] [--trace f1,f2,...]

If no current-ego is given, uses the blank template (inputs/template-ego.md) — the "first
run" / build-from-nothing case.

Reads GEMINI_API_KEY from orbit-station/.env. No running station needed.
"""
import sys, os, json, urllib.request, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
ENV = os.path.join(ROOT, "orbit-station/.env")
PROMPT = os.path.join(HERE, "introspect-prompt.md")
MODEL = os.environ.get("EGO_MODEL", "gemini-2.5-flash")


def gemini_key():
    keys = {}
    for line in open(ENV):
        m = re.match(r"\s*(GEMINI_API_KEY(?:_PAID_ACC)?)\s*=\s*(.+)", line)
        if m and m.group(2).strip():
            keys[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    # prefer the paid account (free tier rate-limits hard on these long prompts)
    return keys.get("GEMINI_API_KEY_PAID_ACC") or keys.get("GEMINI_API_KEY") or sys.exit("no GEMINI_API_KEY")


def call(prompt_text):
    import time
    key = gemini_key()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key}"
    body = json.dumps({"contents": [{"parts": [{"text": prompt_text}]}]}).encode()
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
            data = json.loads(urllib.request.urlopen(req, timeout=120).read())
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 503):
                time.sleep(2 * (attempt + 1))
                continue
            raise
    raise last


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = {a.split("=")[0]: (a.split("=", 1)[1] if "=" in a else True) for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        raise SystemExit(__doc__)

    experience = open(args[0]).read()
    ego_path = args[1] if len(args) > 1 else os.path.join(HERE, "../inputs/template-ego.md")
    current_ego = open(ego_path).read() if os.path.exists(ego_path) else "(no ego yet — first run, build from the template shape)"

    trace_block = ""
    if opts.get("--trace"):
        snaps = []
        for f in str(opts["--trace"]).split(","):
            if os.path.exists(f):
                snaps.append(f"--- ego snapshot: {os.path.basename(f)} ---\n" + open(f).read())
        if snaps:
            trace_block = "\n\n=== THE TRACE (past egos, oldest → newest) ===\n" + "\n\n".join(snaps)

    full = (
        open(PROMPT).read()
        + "\n\n=== THE CURRENT EGO ===\n" + current_ego
        + "\n\n=== RECENT EXPERIENCE ===\n" + experience
        + trace_block
        + "\n\n=== produce the NEXT ego document ==="
    )

    out = call(full)
    out = re.sub(r"^```(?:markdown)?\s*|\s*```\s*$", "", out).strip()

    out_path = opts.get("--out") or os.path.join(HERE, "../outputs/ego-out.md")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, "w").write(out + "\n")
    print(f"model={MODEL}  wrote {out_path}  ({len(out)} chars)\n")
    print(out)


if __name__ == "__main__":
    main()
