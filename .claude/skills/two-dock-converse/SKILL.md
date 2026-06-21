---
name: two-dock-converse
description: Drive a real spoken conversation with a production orbit dock from this laptop (laptop speaker → dock mic → dock brain → dock reply), to stress-test the conversational pipeline and find where it breaks. Use when the user wants to test dock conversation reliability end-to-end with real audio.
---

# two-dock-converse — drive a real spoken conversation with a production dock

You (Claude) are the **driver**. This laptop is one acoustic participant; a **real
production dock** (default `anne-bot-redmi`) is the other. You speak lines out the
laptop speaker; the dock's mic hears them across the room and runs a real turn; you
read the dock's reply (and what it *heard*) back from the station. You decide each
next line — you are the intelligence in the loop. The goal is to **find where the
conversation breaks**: STT mishearings, lost thread, no-reply, loops, persona drift,
latency. Nothing on the dock is modified — it talks to the laptop like it would a human.

## Setup (check once)

- The station must be up (`http://127.0.0.1:8099`) and the dock **online + streaming**
  audio. Verify: `curl -s localhost:8099/api/media/status` shows the dock producer.
- Physical: the laptop speaker must be **audible to the dock's mic**, and not so loud it
  clips. Start at a normal volume.
- For an *addressed* turn the dock needs to be **listening** (its conversation window
  open). Either tap it once at the start, or rely on camera-presence/followup. Check
  state: `curl -s localhost:8099/api/brain/anne-bot-redmi/conversation`.

## The two primitives (in `bin/`)

- **`bin/say.sh "<line>"`** — speak a line out the laptop speaker (the dock hears it).
- **`bin/hear.sh [dock] [timeout]`** — poll the station; print what the dock **HEARD**
  (its STT of your line) and what it **REPLIED**. Exits non-zero if no reply in time.

Both append to `$TWODOCK_LOG` (default `/tmp/two-dock.log`).

## The loop (you run this)

1. **Say** a line: `bin/say.sh "Hey, can you hear me?"`
2. **Hear** the result: `bin/hear.sh` → shows `DOCK-HEARD:` and `DOCK-REPLY:`.
3. **Judge** this turn — and this is the whole point — compare three things:
   - what you SAID
   - what the dock **HEARD** (DOCK-HEARD) → *did STT get it right?*
   - what the dock **REPLIED** (DOCK-REPLY) → *did the brain respond sensibly to what it heard?*
4. **Decide** the next line based on the reply (keep it conversational + natural), and
   loop. Steer toward situations that stress the pipeline (names, numbers, fast back-
   and-forth, topic shifts, ambiguous references).
5. **Log every failure** you observe with which layer failed:
   - **HEARD ≠ SAID** → capture/STT failure (mishearing).
   - **REPLY ignores/contradicts what it heard** → brain/reasoning failure.
   - **no reply** → it didn't hear you (too quiet / not listening) OR stalled.
   - **reply loops / repeats** → conversation-state or model degeneration.

## What to watch for / report

Keep a running tally and summarize at the end: turns attempted, STT mishearings,
brain misfires, no-reply timeouts, loops. Quote the worst examples (said → heard →
replied). The findings feed the recall/capture reliability work
(docs/findings/recall-reliability.md).

## Notes

- Keep lines **short and clear** (one sentence) — long lines stress STT and aren't how
  people talk to a dock anyway.
- If the dock isn't replying, first check it's **listening** (tap / state) and the
  **volume** is high enough for its mic — most "no reply" is one of those, not a bug.
- This is a *real-time acoustic* test: pace yourself (wait for `hear.sh` before the next
  `say.sh`), or the dock's TTS reply and your next line will collide.
