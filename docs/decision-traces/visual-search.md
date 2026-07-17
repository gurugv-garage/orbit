# visual_search — look around and find people or things

*2026-07-17. Status: live on dock-guru-ph (station + app builds 51/52). The
day this went from design to shipped included one full architecture rewrite;
the lessons at the bottom are the valuable part.*

## What it is

One brain tool, `visual_search{query, budget_s, tilt, resume, exclude_current}`,
that physically sweeps the dock's 2 DOF (foot pan ±90°, neck tilt −60…+35),
looks at each pose, and ends **facing** the target. `query` is the user's words
verbatim — "Guru", "anyone", "the TV", "someone who is not Guru" (live), "the
white cup". It is a **bounded in-turn behaviour**, not a task: seconds long,
conversational (its result is the reply), dies with the turn.

The division of labor (the generalizable pattern):

- **LLM before**: picks the knobs from the user's words — observed live,
  unprompted: `tilt:"all"` + `budget_s:30` when scolded to "search better",
  `resume:true` from "yeah continue searching", `exclude_current:true` from
  "no, find somebody else".
- **CODE during**: serpentine sweep plan (small hops, one reversal per row,
  rows stitched snake-wise), awaited moves, per-pose sensing, an incremental
  `SearchContext` (5-min TTL; resume skips only poses seen <45s ago — people
  move), budget, abort (barge-in freezes the body, coverage survives).
- **LLM after**: narrates; the user's next words become a resume/exclude call.
  Steering rides the existing abort+merge machinery — no new channel.

## The sensor and the judge (the rewrite)

Per pose: **one 1280px `capture_still`** (an RPC to the phone; the stream
frame is only a fallback) → **one agentic judge call** — gemini flash-lite
(thinking off) sees the photo + the raw query, and may call one function,
`identify_faces` (face-api on the *same* photo), when identity matters. The
prompt is VISION-FIRST: if no human is visible, answer false *without*
consulting the recognizer. The judged image, the saved proof shot, and the
pose the robot ends up facing are the same artifact by construction.

Proof shots: every judged pose lands in `.data/search` (48h TTL), served at
`/api/observability/search-shot(s)`, rendered in the trace as the found view +
a "judged views" strip; the found frame also floats on the dock's face ~10s
(app build 51). On a find the tool sets the face itself (visual only, no
gesture) and forbids reply `[face:]` tags — a celebratory gesture used to
swing the gaze off the person just found.

## What the first implementation got wrong (kept for the lessons)

The v1 judged 640px compressed WebRTC stream frames with hand-fused face-api
logic, then compensated for the resulting noise with stacked guards: a pixel
size gate, a confidence floor (`max(conf, 0.7)` — overrode the recognizer's
own uncertainty), a phantom-face VLM verifier, a stream-lag freshness window,
a hi-res "escalation" ladder, and a 2-step centering dance built on a guessed
camera mirror-sign. Every guard was a reasonable patch for a live incident;
the stack was the failure. Symptoms it produced live: "found you" while
staring at furniture (face-api hallucinated a 34%-of-frame face and named it),
"found you" while facing away (wrong-sign centering, twice), names assigned
to 13–30px faces that read as four different household members on
consecutive frames.

Lessons (also in the agency-over-guards memory):

1. **Fix order: sensor → judge → guards.** The sharp still existed on the
   phone all along; hours went into guarding a sensor that could never work.
2. **Code owns mechanics, the LLM owns judgment.** Every hand-coded judgment
   (floors, bands, gates) broke; every knob handed to a model worked on first
   exposure. But NOT LLM-in-control-loops: faceFollow's 1Hz servo control
   stays code — agency belongs at judgment nodes.
3. **A weak recognizer must never gatekeep** — it is evidence submitted to a
   judge whose eyes outrank it. flash-lite believes tool authority unless the
   prompt is explicitly vision-first (fixture-proven on the phantom room).
4. **Same-artifact rule**: when the judged evidence, the stored proof, and
   the acted-on result can drift apart, they will, and the bugs are baffling.
5. **Measure physical facts or don't act on them** (the mirror sign).
   Centering is OFF until the sign is measured; the found pose already has
   the target within ±half-FOV.
6. **Non-determinism is the contract** (user): the robot doesn't need 100% —
   it needs to be right most times, honest about misses ("say keep looking"),
   and steerable by voice. Design for retry, not for certainty.
7. **Stale session context outlives tool upgrades**: an open session kept
   believing "I can only find people" from a pre-upgrade error. After a
   capability change, end the session or correct the record.

## Verified

Unit: plan properties (serpentine hops), found-early stop, budget, abort with
coverage preserved, resume recency, exclusion, stalled-camera honesty. Fixtures
(real room frames, real Gemini): phantom room rejected, cropped-face honesty
("Aanya visible, Guru is not"), bottle found with position, TV honest no.
Live by the user's own voice: find-me; find-TV (honest miss → "yeah continue
searching" → found at 60° left in 6s); "somebody who is not Guru" →
exclude → Shwetha; photo-to-Slack chaining; remember_face correction.
