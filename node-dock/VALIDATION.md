# Agentic dock — validation log

Records every flow test during the pi-kt agentic migration. Each entry: what was
driven, the event/log evidence, verdict. **Log-validated** = confirmed via
DOCK_EVT trace + logcat (no physical eyeball yet). **Eyeball-pending** = needs the
user to physically confirm (servo motion seen, status on screen, audio overlap).

Setup: phone Redmi 6 Pro `69b106280505` · Ollama `gemma4:e2b` @ `192.168.1.10:11434`
· ESP32 XIAO body @ `192.168.1.14:17317` (parts: neck, foot).
Driven via `adb shell am broadcast -a dev.orbit.dock.debug.SAY -e text "…"`.

---

## ✅ Log-validated

### T1 — single action turn
Cmd: "say hi and look to the left". Result: `set_face{happy}` executed
(`tool.setFace: happy`); `move_body{neck,left}` rejected by part-state validation
("neck has no 'left'"), model reacted: "I can look up/down/center. I can't look
left." Native tool calls (not spoken). Waiting→Thinking→tool→Speaking. **PASS** (tool calls real, reaction correct). Eyeball-pending: face actually changes to happy on screen.

### T2 — real body movement (HARDWARE)
Cmd: "look down please". Result: `move_body{neck,lookDown}` → "ok — running 1 moves"
→ **`BodyLinkComms: applied ack id=st-1 parts=[neck] status=applied`** (ESP32
acknowledged + moved). Spoke "Okay, I will look down for you." **PASS** — full
chain to real servo works. Eyeball-pending: neck servo physically tilts down.

### T3 — react to tool result
Cmd: "nod your head yes". gemma emitted `move_body{neck,nodYes}` (invalid — not in
enum), validation rejected, model adapted: "I can nod for you." No servo moved
(model never picked a valid state). **PASS for reaction**; **FAIL for intent** —
"nod" needs a gesture vocabulary (see tuning T-tune-1).

---

### T4 — gesture vocabulary (HARDWARE, multi-step)
Added a `gesture` tool (nod/shake_head/wiggle/look_around/look_up/look_down) that
expands to a validated DockTools sequence. Cmd: "nod your head yes". Result:
`gesture{nod}` → "ok — running 4 moves" → **4× `applied ack [neck]` from ESP32**
(st-1..4). Spoke "That was a nod." **PASS** — gemma used the verb instead of
inventing a state; real 4-step neck gesture on hardware. Eyeball-pending: neck
visibly nods 2×.

### T6 — vision turn (HARDWARE camera, real scene)
Robot placed in the phone camera view. Cmd: "what do you see right now". Camera
frame (dumped: white articulated dock body in a living room w/ teal sofa, wooden
cabinets). gemma: **"I see a living room with a blue couch and some wooden
cabinets. It looks pretty cozy."** — accurate to the frame. **PASS** — agentic
vision path works. Note: did an unprompted `move_body{neck,center}` first (eager;
UX tunable). Frame orientation correct (upright/un-mirrored).

### T7 — talk-while-moving (observed in T4)
In T4 the SPEAK events (`13:29:06.25`) interleaved with body acks (st-3 `.567`,
st-4 `.07.388`) — speech streamed DURING the servo sequence, not after.
**PASS (log timing)**. Eyeball-pending: hear speech while seeing motion.

### T-seq — model-authored motion (move_sequence, HARDWARE)
Added `move_sequence` so the model composes arbitrary motion (not just fixed
gestures). Cmd: "slowly look up, pause, then look down, then center". gemma
emitted `move_sequence{steps:[{neck,lookUp,wait_ms:1000},{neck,lookDown,1000},
{neck,center}]}` — **it authored the steps + waits itself**. → "running 3 moves"
→ 3× `applied ack [neck]` with real ~1.4s gaps (the requested 1000ms + travel).
Spoke during motion. **PASS** — addresses the "fixed vocabulary is limiting"
concern: full expressive motion from language. Eyeball-pending: neck does the
slow up→down→center.

## UI screenshot validation
`tmp/ui_speaking.png` (mid-turn): status pill **SPEAKING**, body badge green
**neck: center** (real ESP32 connected), face rendered **happy** (set_face fired),
subtitle streaming the story, camera thumbnail shows the robot scene. On-screen UI
correct + live. **PASS (T11 log+screenshot)**. Eyeball-pending: user confirms.

### T8 — mid-turn supersede / cancellation (barge-in core)
First attempt exposed a REAL BUG: a 2nd utterance hit pi-kt's one-run-at-a-time
guard → "agent busy", first turn orphaned (cancel() didn't await pi-kt's
`activeRun` reset, which runs in a `finally`). **Fixed**: `respond()` now
`cancelAndJoin`s the prior turn before the new one; `stop()` calls `agent.reset()`.
Re-test: 1st turn ran, 2nd ("just say okay") completed with "Okay.", **0 busy
errors**. **PASS** (supersede/cancel). Eyeball-pending: tap-driven barge-in
(WakeWord+tts.stop+agent.stop) — uses same stop() path; needs physical tap.

### T9 — unreachable model fallback
`DockAgentTurnTest` (4/4) against the new facade: unreachable host → DockStreamFn
emits error event → "I couldn't reach my local model" + Failed, no hang.
Supersede + stop()→Idle + not-configured also covered. **PASS (unit)**.

### T-extra — parallel multi-tool + multi-step (post-cleanup smoke)
"wiggle a little and say hi" → TWO tool calls in one message (`gesture{wiggle}` +
`set_face{happy}`), wiggle ran **5 moves** (5 acks), face happy, then loop round 2
spoke "Hi there! Hope you're having a nice moment." **PASS** — the full agentic
UX (parallel tools, multi-step, talk-while-move) firing together on hardware.

## Test totals (log/unit validated)
- agent-core: 52/0 · app: 148/0 (incl. new NdjsonAssistantParser + DockToolsAdapter
  + rewritten StreamingReplyExtractor tests).
- All on-device flows traced via DOCK_EVT (debug-gated). VALIDATION evidence above.

## Cleanup done
- wrapReply JSON hack removed; StreamingReplyExtractor is plain-text native.
- DOCK_EVT tracing gated to BuildConfig.DEBUG.
- Stale KDoc fixed; LIFECYCLE.md + STRUCTURE.md + UX.md updated for agentic arch.
- experiments/pi-kt deleted (vendored as :agent-core).

## 👁 Physical eyeball pass (with user, voice input via tap-to-talk)

### S1 — "look down" — ✅ GO (user-verified)
First run: servo moved correctly, BUT two UI bugs: (a) subtitle stuck on the
user's transcript when the LLM only acted (no spoken reply); (b) status/face
stuck on "listening" after the turn. **Fixed**: `DockTools.endTurn` now silences
the face + clears subtitle when nothing was spoken; `onTurnSettled` →
`PerceptionWiring.clearTranscript()` clears the lingering transcript. Tests added
(DockToolsRealisticTest endTurn cases), 150/0. Re-tested: servo moves
(`applied ack st-1`), UI settles clean. **User: "perfect".**

### S2 — "nod your head" — ✅ GO (user-verified: "it noded")
Via voice, STT misheard "nod"→"not your head" → gemma sensibly declined (dock
behaved correctly on garbage input; not a bug). The repeating `java.lang.Long
cannot be cast to java.lang.Integer` in logs is **system noise (PID 937, tag
Bundle = MIUI speech service), NOT our app** (0 from our PID). Re-ran with exact
text injected: `gesture{nod}` → 4 moves → 3 neck acks → **physical nod confirmed
by user**. Lesson: inject exact text to validate dock behavior; treat voice-STT
accuracy as a separate scenario.

### S3 — move_sequence + the IMAGE-vs-MOVEMENT bug (major finding)
Voice "slowly look up…" → no movement. Root cause (proved via direct Ollama
calls): **with the camera image attached every turn, gemma4:e2b (5B) fixates on
describing the scene and ignores movement tool calls** — even with a prompt
saying "ignore the image unless asked, you MUST call the tool to move." Camera
OFF → same command works 100%.
**Fix**: configurable `gateImageToVisionIntent` flag (default ON) — attach the
frame only on vision-intent turns (`isVisionIntent` regex, unit-tested); movement
/chat go text-only. Flag off for a stronger model that handles image-always.
Plus a sharper system prompt (image = eyes' input; body = separate; MUST call
tool to move). Re-validated: **movement 4/4 reliable** (look/nod/turn all
tools=1, acks 1-4), **vision still works** ("I see a person looking at me, they
seem to be smiling"). Tests: 152/0. move_sequence timing (waits) confirmed on
wire earlier. **S3 eyeball: ✅ GO** — user confirms the slow up→down→center physically (gemma
set wait_ms:1000 per step; acks ~1.4s apart; "works").

OPEN UX item: gemma usually emits the tool call FIRST then speaks (so you see
"move, then speak"). Code does NOT serialize (speech+motion are parallel,
fire-and-forget) — it's the model's output order. TODO: nudge prompt to
speak-first / interleave, OR accept. Not a bug.

### S4 — "say hi and smile" — ⚠️ partial (mechanics good)
Spoke "Hi!" + moved + settled clean, but did a nod instead of set_face{happy}
(STT/small-model variance on "smile"). Mechanics fine; exact expression not
guaranteed. User: "seemed to work… anyway done."

### Bug: announce-then-stop (tool call truncates spoken content) — FIXED
Live: "move your head and tell me a poem" → moved + said "Here is a short poem"
but NEVER said the poem. Isolated: poem WITHOUT movement → full poem delivered;
WITH a tool call → only the lead-in, then stop. So the tool call + loop
continuation truncates the spoken content (gemma treats round 2 as a fresh tiny
reply). **Fix**: system prompt now says "say everything in the SAME reply as your
tool calls — don't just announce and stop." Re-tested: "nod and tell a poem" →
nod + full poem, both runs. Movement still 3/3 reliable, 153/0. Related to the
move-then-speak ordering note.

### Facade→body integration test (added per user)
`DockAgentBodyTurnTest`: scripted StreamFn emits move_body → asserts the real
body's setState fired through the full DockAgent facade. Plus agent-core has
`MultiStepAgentTest` (N sequential tool turns + terminate) — the agentic
multi-step coverage. app 153/0, agent-core 52/0.

## 🔎 REMAINING eyeball scenarios
Everything above is log/event-validated. Still needs the user to physically
confirm each scenario (servo motion, on-screen status/face, audio overlap, voice
STT). Go/no-go per scenario together. Auto-relisten voice loop also needs a real
spoken turn (laptop→phone STT was unreliable; use the phone directly or fix mic).
- T7 talk-while-moving — SPEAK events overlap body set_target in time
- T8 barge-in (tap mid-speak) + long-press hard abort
- T9 unreachable model → fallback line, no hang
- T10 live status UI sequence renders (eyeball)
- T11 auto-relisten after a spoken agentic turn

## 🔎 Eyeball-pending (physical pass with user at the end)
T1 face change · T2 neck tilts down · (all servo motions) · T10 on-screen status ·
audio overlap for T7.

## Known model quirks (gemma4:e2b, small 5B)
- Inconsistent enum honoring (honored neck,left; invented nodYes). Mitigation: keep
  schemas tight + adapter validates + model reacts to rejection.
- Treats gestures (nod/wiggle) as single states. Mitigation: gesture vocabulary.
- Prompt-sensitive: verbose prompt → inlines tool calls as speech. Mitigation:
  terse tool-first system prompt (fixed).
