# Conversation-state test cases (the spec)

> Test-FIRST: these define the behavior the reimplementation must hit. Each case has:
> **UX** (what the user does → experiences), **STATE** (deterministic assertion on
> the pure `ConversationState`), and **VALIDATE** (exactly how I verify it — log /
> event / REST probe / screenshot — and any instrumentation we BAKE IN to make it
> observable). Timings reference `ConvCfg` constant names, never magic numbers.
>
> **Testability is a first-class requirement.** If a transition isn't observable, we
> add the hook to observe it as part of building it (see "Instrumentation to bake in").
>
> Sections: **active flows** (build now), **Reconnections** (separate sim harness),
> **Barge-in** (implement later — review first), **STT layer** (Bug #1).

---

## Instrumentation to bake in (so everything is testable headless)

These are built ALONGSIDE the state machine — testability is part of the feature:

1. **`GET /api/brain/:dock/conversation`** — the live conversation state:
   `{ mode, windowUntil, speakUntil, msToExpiry }`. The primary REST probe for
   every STATE assertion (poll it through a flow).
2. **`conversation`-state-change events on the obs/agent stream** — every
   transition emits `{ dock, from, to, reason, at }`. Lets a test assert the exact
   transition sequence (not just the end state), and drives the phone renderer.
3. **`POST /api/brain/:dock/debug/event`** — inject a raw conversation event
   (`tap` / `utterance{text,endedAt}` / `vad` / `tts-start` / `tts-end` /
   `connected`) at a controllable time. Drives EVERY flow headless, no mic. (Extends
   the existing `debug/say`.)
4. **Structured single-line logs** `[conv] dock mode A→B (reason)` — for adb/station
   log assertions when a REST poll would miss a fast transition.
5. **Phone:** the existing `DOCK_EVT` logs (face/beep) + a `present` frame the phone
   receives — so a test can confirm the phone rendered the station's intent.

VALIDATE notes below reference these by number.

---

## Group A — the basic addressed turn

### A1. Tap, speak, get a reply — and the listening lifetime
- **UX:** tap → beep + listening face → "what's two plus two?" → thinks → speaks
  "four" → auto-listens (C1). While listening: talking holds it; silence closes it
  after a bounded time.
- **STATE:** idle →tap→ listening (window = now + `LISTEN_MS`); no VAD → expires at
  `LISTEN_MS` → idle; VAD → window extends to now + `VAD_EXTEND_MS`;
  utteranceEnded(in window) → addressed → thinking → speaking → followup.
- **VALIDATE:**
  - unit: pure ConversationState with injected clock (mode + window assertions).
  - headless E2E: `debug/event tap` → poll `GET /conversation` (1) shows `listening`
    + `msToExpiry ≈ LISTEN_MS`; `debug/event vad` → poll shows `msToExpiry` jumped to
    `VAD_EXTEND_MS`; `debug/event utterance` → obs transition stream (2) shows
    listening→thinking→speaking→followup.

### A2. Tap, say nothing → gives up after `LISTEN_MS`
- **UX:** tap → listening → silent → after `LISTEN_MS`, face idle, off beep.
- **STATE:** listening; advance past `LISTEN_MS` → idle.
- **VALIDATE:** unit (clock advance). E2E: `debug/event tap`, poll `/conversation`
  every 1s; assert `idle` appears at ≈`LISTEN_MS`; obs stream shows listening→idle
  (reason: timeout). Phone: `DOCK_EVT` shows listening-off beep.

### A3. Speak without tapping → overheard, but STILL TRANSCRIBED
- **UX:** I chat to someone nearby → no response.
- **STATE:** idle; utteranceEnded → addressed=false; stays idle.
- **VALIDATE:** unit (addressed=false). Integration: feed an utterance with NO prior
  tap (real STT or `debug/event utterance`); assert (a) a **speech snapshot exists**
  via `GET /api/perception/snapshots` (transcription happened), AND (b) **no turn
  ran** (`/conversation` stays idle; session turn count unchanged).

### A4. Tap before the sentence ends → it works (merged A4+A5)
- **UX:** I start speaking and tap before my last word → it answers the whole
  sentence.
- **STATE:** utterance started before the tap; tap during it; utteranceEnded(after
  tap) → addressed=true.
- **VALIDATE:** unit (ordering). E2E: `debug/event utterance{startedAt:T0}` interleaved
  with `debug/event tap{at:T0+x}` then `utterance-end` → obs stream shows the turn ran.

---

## Group B — speaking (the dock's own voice vs. others)

### B1a. The dock's own TTS is NOT transcribed back
- **UX:** dock talks → no self-response.
- **VALIDATE:** integration (have today): trigger a reply, baseline speech-snapshot
  count via `GET /api/perception/snapshots`; assert count does NOT increase with the
  dock's TTS text. (Already passing.)

### B1b. Someone else speaking DURING the dock's TTS still gets transcribed
- **UX:** (barge-in foundation) dock talking + a DIFFERENT voice → that voice is
  transcribed.
- **VALIDATE (no human):** trigger a long reply; WHILE it speaks, **play an audio
  file at the mic** (not via WebRTC → not the AEC reference). Assert via
  `/snapshots`: the dock's TTS text is absent, the audio-file phrase IS present.
  BAKE IN: an `adb`-driven audio-play helper (push a WAV, `media` play through the
  speaker) — document the exact command. Confirms the AEC margin for barge-in.

---

## Group C — auto re-listen (follow-up)

### C1. Reply → follow up WITHOUT tapping — several loops
- **UX:** ask → answer → beep (listening) → follow-up NO tap → answer → waits
  `FOLLOWUP_MS` → ask again → … a multi-turn back-and-forth.
- **STATE:** speakEnd → followup (window = now + `FOLLOWUP_MS`); utteranceEnded(in
  followup) → addressed → thinking → speaking → followup. **≥3-4 loops.**
- **VALIDATE:** unit (loop the transitions). E2E (no mic): `debug/event tts-end` →
  `/conversation` shows `followup` + `msToExpiry≈FOLLOWUP_MS`; `debug/event utterance`
  → turn runs; repeat 4×; assert each loop via the obs transition stream (2).

### C2. Reply → silence → stops after `FOLLOWUP_MS`
- **UX:** answer → beep on → quiet → after `FOLLOWUP_MS`, beep off, idle.
- **STATE:** followup; advance past `FOLLOWUP_MS`, no utterance/vad → idle.
- **VALIDATE:** unit + E2E: after `tts-end`, poll `/conversation`; assert idle at
  ≈`FOLLOWUP_MS`; phone `DOCK_EVT` off beep.

### C0. Follow-up opens after EVERY reply (decided: user- AND not-user-initiated)
- **DECISION:** the follow-up (auto re-listen) window opens whenever the dock
  finishes speaking, regardless of what triggered the turn — a user-addressed turn,
  a proactive self-thought, or a task notification. (Simpler rule; the dock is
  always ready for a follow-up after it speaks.)
- **UX:** I ask → it answers → it listens (follow-up). It proactively says "I see
  you're back" → it ALSO listens after, in case I respond.
- **STATE:** speakEnd → followup, independent of trigger (ConversationState only
  sees speakStart/speakEnd — it's trigger-agnostic by construction).
- **VALIDATE:** unit — two cases: (a) tap→turn→speak→speakEnd→followup;
  (b) NO tap, turn→speak→speakEnd→followup. Both followup. (conversation-state.test.ts)
- **NOTE:** a queued self-thought defers behind the follow-up window (the user
  might be following up) — see autonomous.test.ts.

### C3. Slow follow-up — start late, it waits (`VAD_EXTEND_MS`)
- **UX:** answer → I pause then start → not cut off.
- **STATE:** followup; vadActivity before window end → window → now + `VAD_EXTEND_MS`;
  utteranceEnded after original `FOLLOWUP_MS` but within extension → addressed=true.
- **VALIDATE:** unit (extend edge). E2E: `tts-end` → wait → `debug/event vad` →
  `/conversation` `msToExpiry` jumps; late `utterance` still runs a turn.

---

## Group D — priority

### D1. Tap is a TOGGLE
- **UX:** idle + tap → listening; already-listening + tap → OFF (idle). Tap flips it.
- **STATE:** idle →tap→ listening →tap→ idle; followup →tap→ idle.
- **VALIDATE:** unit (toggle). E2E: `debug/event tap` ×2 → `/conversation` idle→
  listening→idle; phone `DOCK_EVT` on-beep then off-beep.

### D2. Leave camera during follow-up → KEEPS listening
- **UX:** in follow-up, glance away → conversation not abandoned.
- **STATE:** followup; face-leave does NOT clear it.
- **VALIDATE:** unit (face-leave is a no-op on followup at station). Phone
  integration: `present` mode stays listening when a FaceLost arrives during followup
  (phone-renderer test). Screenshot of the face still showing listening (optional).

### D3. Face arriving doesn't override active tap/follow-up
- **UX:** mid-conversation, a new face → no reset.
- **VALIDATE:** unit (lower-priority arrival no-ops). E2E: in followup, inject a
  face-arrival listen request → `/conversation` mode unchanged.

---

## ── Reconnections (SEPARATE — needs a simulation harness) ──

> Build a disconnect/reconnect SIM (drop the phone's WS, drop frames), then assert:
- **R1. Lost "TTS finished":** speaking; never get `tts-end`; assert recovery —
  `/conversation` leaves speaking by `SPEAK_MAX_MS` AND `reconcileConnected()`→idle.
- **R2. Phone reconnect → clean slate:** any mode; reconnect → idle.
- **R3. Disconnect mid-listening/followup:** window doesn't leak; reconciles.
- **R4. Station restart / dock re-hello:** state re-established.
- **R5. CLEAN RESET on APP restart (user-requested):** the phone app restarts →
  reconnects → `hello` → reconcile → from ANY prior mode the conversation comes
  back CLEAN idle (no stale listening/speak window). UNIT: reconcile from every
  mode → idle + windowUntil/speakUntil both 0 (conversation-state.test.ts). LIVE:
  restart the app; `GET /conversation` shows idle; any live face presence then
  opens its OWN window (which expires → idle), proving it's fresh not stale.
- **R6. CLEAN RESET on SERVER restart (user-requested):** a fresh station process
  is a new ConversationState → idle by construction; the phone reconnects into it
  via hello (reconcile + resync frame). UNIT: a new instance is idle. LIVE:
  observed every `tsx watch` reload — phone reconnects, `/conversation` settles to
  idle (a live face window may briefly open, then expires → idle). VERIFIED.
- **VALIDATE:** R1-R4 need a WS-drop sim (BAKE IN: a debug WS-drop trigger or a
  scripted fake-peer). R5/R6 are unit-tested + live-verified now via `/conversation`
  + the `[conv]` logs.

---

## ── Barge-in (TO IMPLEMENT LATER — review cases before building) ──

> NOT implemented. Today barge-in can't work — while speaking the dock isn't in a
> listening window. Target cases (REVIEW before building):
- **BI1.** Talk over the reply → it stops + answers the new thing.
- **BI2.** It doesn't barge in on itself (depends on B1b's AEC margin).
- **VALIDATE (later):** built once designed; will reuse `debug/event` + `/snapshots`.

---

## ── STT layer (Bug #1 — not the state machine) ──

### F1. A short word ("yes"/"no"/"ok") registers
- **UX:** "ready?" → "yes" → heard, not dropped.
- **VALIDATE:** play a short-word WAV at the mic; assert a speech snapshot appears.
  Tune `MIN_UTTERANCE_MS`. (STT integration.)

---

## Events we must ADD (and bake in for testability)
- `vadActivity` phone→station (extends the window; A1/C3) — VAD is phone-local today.
- `tts-start`/`tts-end` phone→station as the single speaking driver (exists as
  speech-status; make it authoritative).
- `tap` as a TOGGLE (D1) — the `addressed` frame toggles, not just arms.
- `phone-connected` reconcile (R1/R2).
- All of the "Instrumentation to bake in" probes (1–5).
