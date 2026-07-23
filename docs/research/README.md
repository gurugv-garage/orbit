# External research

Studies of **external implementations and tech** (other robots, agent stacks,
STT/TTS/vision pipelines, libraries) that could inform orbit. Each entry captures
what was found, **when**, against **which versions of both codebases**, and **how**
the analysis was done — so a later reader can trust the findings, see what has
since drifted, and re-validate or extend them.

This folder is the durable home for "we looked at X, here's what's worth taking."
It is NOT a place for orbit's own design decisions — those live in
[decision-traces/](../decision-traces/), [PLAN.md](../PLAN.md), and the module docs.

## Index

| Entry | Subject | First researched | Last updated | Status |
|---|---|---|---|---|
| [livekit-agents.md](livekit-agents.md) | LiveKit Agents as a speech-to-speech orchestration base (barge-in/turn-taking/tool interleave) — source-read fit study; compared against Pipecat | 2026-07-22 | 2026-07-22 | active |
| [pipecat-orchestration.md](pipecat-orchestration.md) | Pipecat (`pipecat-ai/pipecat`) as a conversation-orchestration base — fit assessment (deep-research + adversarial verify) | 2026-07-22 | 2026-07-22 | active |
| [perceptual-memory.md](perceptual-memory.md) | Visual entity memory (faces/places/things) via embeddings + small VLM — feasibility & POCs | 2026-07-08 | 2026-07-08 | active |
| [pibot.md](pibot.md) | `badlogic/pibot` — local-first voice robot on the same `pi` agent kernel | 2026-06-22 | 2026-06-22 | active |

<!-- add a row per entry; keep newest research at the top of the table -->

## How to write an entry

Every entry MUST carry, at the top, a **Provenance** block and, as its spine, a
**Things to note / takeaways** section. The other sections are supporting evidence.

### Required structure

1. **Provenance** (a table — see template below): research date(s), the external
   subject's exact commit/version + URL, the orbit commit/branch at analysis time,
   the analyst, and **the method** (what was actually done).
2. **Method & honesty** — one short paragraph stating plainly what was and was NOT
   done. Did you *run* the external code? *Benchmark* it? Or only *read the source*?
   Did you read orbit's real code, or reason from docs/memory? Be explicit; a wrong
   provenance claim poisons every takeaway below it.
3. **Things to note / takeaways** — THE point of the entry. For each takeaway:
   - a one-line claim,
   - confidence (high/medium/low) and *why*,
   - whether it's **steal / skip / already-have / watch**,
   - the cite (external `file:line` and the orbit `file:line` it bears on),
   - so a reader can act without re-reading the whole study.
4. **Supporting analysis** — the deeper dives that justify the takeaways.
5. **Update log** — append-only; never rewrite history (see below).

### Dates & lineage (why this matters)

Both codebases move. A takeaway like "they prepend VAD preroll, we should too" can
be **already done** three weeks later, or aimed at code that was since deleted. So:

- Pin the **exact commit** of the external repo AND of orbit at analysis time.
- Convert relative dates to absolute (ISO `YYYY-MM-DD`).
- When you revisit, **append** a dated entry to the Update log with the new commits
  and what changed — do not edit old findings in place. Strike through a takeaway
  that's been invalidated and say why, rather than deleting it.

### Re-validation checklist (run when revisiting an entry)

1. `git -C <external clone> log -1` and orbit `git log -1` — record both commits.
2. Diff the orbit files each takeaway cites against the versions noted — did the
   thing we said we lacked get built? did the file move?
3. Re-clone the external subject; check whether the cited external code still exists
   and still does what the entry claims.
4. Append an Update-log entry with date, both commits, and per-takeaway status.

### Provenance block template

```markdown
| | |
|---|---|
| **Subject** | name + URL |
| **Subject commit** | `<sha>` (`<date>`) |
| **Orbit commit** | `<sha>` on branch `<branch>` (`<date>`) |
| **Researched** | YYYY-MM-DD |
| **Analyst** | who |
| **Method** | cloned + read source / ran it / benchmarked it / read orbit code+docs … |
```
