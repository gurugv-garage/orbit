# Monitoring results

One entry per run, **newest first**. Produced by the routine in
[README.md](README.md) from `collect.mjs` output — stored data only, no live
testing. The point of this file is the TREND: a later run should be able to read
the last few entries and tell whether anything moved.

## Entry template

```markdown
## YYYY-MM-DD — <window, e.g. last 24h> · dock-<name>
**Verdict:** healthy | watch | degraded — one sentence.

| metric | value | vs last | note |
|---|---|---|---|
| turns / heard / sessions | | | |
| drops (voiced-fraction / min-utt / while-speaking) | | | |
| stt lag p50/p90 | | | |
| ranTurn / skip:not-addressed / skip:stale | | | |
| barge holds / self-motion skips / yielded | | | |
| silent / errored / unfinished turns | | | |
| firstSpeech p50/p90 | | | |
| cost total / per-turn / cache% | | | |

**Tripped thresholds:** …(or none)
**Investigated:** …what you opened, what the evidence showed
**Changes since last run:** …deploys, threshold edits, sideloads
**Carry forward:** …what the next run should check specifically
```

---

## 2026-07-23 — last 24h · dock-redmi (baseline)
**Verdict:** watch — nothing broken, but this is the first run and two known-open
issues have their first numbers. Heavy dev/test traffic today, so treat volumes
as un-representative of a normal day.

| metric | value | vs last | note |
|---|---|---|---|
| turns / heard / sessions | 118 / 124 / 26 | — | baseline; a lot of it is my own testing |
| drops (voiced-fraction / min-utt / while-speaking) | 625 / 475 / 29 | — | high, but the day included deliberate noise trials |
| stt lag p50/p90 | 239ms / 493ms | — | healthy (<1s) |
| ranTurn / skip:not-addressed / skip:stale | 35 / 83 / 9 | — | skip-heavy is expected (room chatter, no tap) |
| barge holds / self-motion skips / yielded | 14 / 17 / 5 | — | **skips > holds — the known-open guard issue** |
| silent / errored / unfinished turns | 3 / 0 / 1 | — | clean |
| firstSpeech p50/p90 | 4.8s / 9.1s | — | p50 under the 5s bar; p90 is the known TTS-delay tail |
| cost total / per-turn / cache% | $0.67 / $0.0056 / 13% | — | 7-day range $0.09–$3.76; today mid-range |

**Tripped thresholds:**
- `barge.skipSelfMotion (17) > holds (14)` — more interruptions suppressed by the
  servo-noise guard than allowed to pause the reply.
- `cost.cachePct 13%` — below the >30% guide, but see note: the prompt-stability
  fix landed mid-window, and implicit caching needs rapid back-to-back turns.

**Investigated:**
- Self-motion skips → **CONFIRMED BUG.** `probe.mjs suppressed-barges`: **12 of
  17 (71%)** suppressed onsets had a real transcript within 8s, including
  "Wait, I am interrupting you right now. Please pause" (11:51:21) and
  "Actually hold on. I'm about to ask you something…" (12:05:51). Those people
  were talked over. Mechanism: the 1.8s mute re-arms with every gesture and the
  dock gestures throughout a reply, so the barge pause is effectively
  unavailable for much of any animated turn. Not fixed — see README known-open.
- Voiced-fraction drops: swept all 533 kept clips through STT earlier today; 86
  (16%) contained real words at the OLD flat 35% floor, incl. "I don't know if
  you hear me clearly now". Fixed same day by the two-tier floor (35% while
  speaking / 10% idle); re-sweep in a few days to confirm the drop rate falls.

**Changes since last run (all 2026-07-23):**
conv_events + Timeline + incident bundle; static system prompt (cache);
stale-frame pruning; two-tier voiced floor; dual silence floor (barge
endpointing); wordless-barge resume; tapOpen provenance; ⏹ stop badges.

Other probes this run: `endpoint-lag` 84% of barges endpoint DURING the reply
(the dual-floor fix holding; was ~64% before it); `tts-delay` p50 293ms, and
long replies at **-654ms** (speech starts BEFORE the model finishes — sentence
streaming working); `followup-chains` longest chain only 3 turns (healthy).

**Carry forward:**
1. ~~Measure self-motion skips that had words~~ — done: 71%, confirmed bug. Fix next.
2. Re-sweep dropped clips for real speech under the new two-tier floor
   (`probe.mjs dropped-speech`, needs the sidecar up).
3. Watch `cost.cachePct` over a normal conversational day now that the prompt is stable.
4. Phone lane is still dark in conv_events — needs the app sideload.
