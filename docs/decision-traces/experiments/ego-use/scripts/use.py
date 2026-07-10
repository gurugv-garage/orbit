#!/usr/bin/env python3
"""
USE experiment (ego.md §3.5): does the ego drive behaviour? Feed the SAME scenario to
DIFFERENT egos and compare what each decides to do. If behaviour differs by ego, the ego
is a driver, not a diary.

Runs every ego × every scenario, prints a grid, writes outputs/grid.md.
Reads GEMINI_API_KEY (paid preferred) from orbit-station/.env. No station needed.
"""
import os, glob, json, urllib.request, re, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
ENV = os.path.join(ROOT, "orbit-station/.env")
PROMPT = open(os.path.join(HERE, "use-prompt.md")).read()
MODEL = os.environ.get("EGO_MODEL", "gemini-2.5-flash")


def key():
    ks = {}
    for line in open(ENV):
        m = re.match(r"\s*(GEMINI_API_KEY(?:_PAID_ACC)?)\s*=\s*(.+)", line)
        if m and m.group(2).strip():
            ks[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return ks.get("GEMINI_API_KEY_PAID_ACC") or ks.get("GEMINI_API_KEY") or exit("no key")


def call(text):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key()}"
    body = json.dumps({"contents": [{"parts": [{"text": text}]}]}).encode()
    for i in range(5):
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
            d = json.loads(urllib.request.urlopen(req, timeout=120).read())
            return d["candidates"][0]["content"]["parts"][0]["text"].strip()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 * (i + 1)); continue
            raise
    raise SystemExit("gemini failed after retries")


def main():
    egos = {os.path.basename(f)[4:-3]: open(f).read() for f in sorted(glob.glob(f"{HERE}/../egos/ego-*.md"))}
    scenarios = {os.path.basename(f)[:-4]: open(f).read().strip() for f in sorted(glob.glob(f"{HERE}/../scenarios/*.txt"))}

    out = ["# USE experiment — same scenario, different egos\n",
           f"model={MODEL}. Each cell = what that ego decided to DO.\n"]
    for sname, stext in scenarios.items():
        out.append(f"\n## scenario: {sname}\n> {stext}\n")
        for ename, etext in egos.items():
            full = f"{PROMPT}\n\n=== THE EGO ===\n{etext}\n\n=== THE SITUATION ===\n{stext}\n\n=== decide ==="
            res = re.sub(r"^```.*?\n|```$", "", call(full)).strip()
            out.append(f"### ego: **{ename}**\n```\n{res}\n```\n")
            print(f"[{sname} × {ename}]\n{res}\n{'-'*60}")

    op = os.path.join(HERE, "../outputs/grid.md")
    os.makedirs(os.path.dirname(op), exist_ok=True)
    open(op, "w").write("\n".join(out) + "\n")
    print(f"\nwrote {op}")


if __name__ == "__main__":
    main()
