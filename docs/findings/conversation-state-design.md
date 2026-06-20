# Conversation state — clean foundation (design for sign-off)

> The listening/speaking/turn flow has produced repeated bugs (stuck speaking,
> follow-up not registering, intermittent no-response) because the state is
> **fragmented across three uncoordinated owners on two machines**. This proposes
> ONE coherent model. Review before I implement.

## The problem (why patches keep failing)

Today "is the dock idle / listening-for-user / thinking / speaking / awaiting-
follow-up?" has **no single owner**:

| Owner | Where | Holds | Problem |
|---|---|---|---|
| `DockBrainSession` state | station | `#speaking`,`#listening`,`#running`,`#turnActive` | `#speaking` cleared ONLY by a phone frame → lost frame = stuck forever (Bug #3) |
| `addressedLatch` (Map) | station, SEPARATE file | tap→utterance correlation | doesn't know about session state or follow-up (Bug #2) |
| `ListeningArbiter` | PHONE | listening holds (tap/follow-up/face) | drives the face + when to send `addressed`, but the STATION is the real decider — they desync |

Three sources of truth for one concept → they drift → bugs. Each fix patches one
desync; the next appears elsewhere.

## The principle

**The STATION owns conversation state. The phone is I/O.**
- The phone reports **raw events**: tap, VAD start/stop, TTS playback start/end,
  (re)connect. It does NOT decide "am I addressed / awaiting follow-up".
- The station owns the **conversation state machine** and the addressed decision.
- The station tells the phone what to **present**: show-listening, beep-on/off,
  speak. The phone's "arbiter" becomes a thin renderer of station intent, not a
  second brain.

## The state machine (one, on the station, per dock)

```
            ┌────────── user turn / addressed utterance ──────────┐
            v                                                     │
  IDLE ──tap/wake──▶ LISTENING ──utterance(addressed)──▶ THINKING ─┘
   ▲                  │  ▲                                  │
   │                  │  │ VAD extends                      ▼
   │      no-speech    │  └───────────────────────── SPEAKING (TTS)
   │      timeout      │                                    │
   │                  ▼                                     │ TTS end
   └──── followup window expires ◀──── FOLLOWUP ◀───────────┘
                       (auto re-listen, N s, VAD-extends)
```

States (single enum, station-owned, per dock):
- **IDLE** — not in a conversation. Mic still on (ambient), but nothing addressed.
- **LISTENING** — addressed window open (a tap, or auto re-listen). The next
  endpointed utterance becomes a turn. Drops to IDLE on no-speech timeout.
- **THINKING** — a turn is running (the brain loop).
- **SPEAKING** — TTS playing the reply.
- **FOLLOWUP** — just finished speaking; auto re-listening N s for a hands-free
  follow-up (= LISTENING but entered automatically; VAD-extends; lower priority
  than an explicit tap).

The **addressed latch folds into this**: "are we LISTENING/FOLLOWUP?" IS the
addressed decision. No separate Map.

## Events IN (phone/perception → station state machine)

- `tap` — user explicit → LISTENING (high priority).
- `utterance(text, window)` — a finalized STT transcript. If LISTENING/FOLLOWUP →
  becomes the turn (THINKING). Else overheard (ignored, or → attention gate later).
- `vad(active)` — extends a FOLLOWUP/LISTENING window; never starts one alone.
- `tts-start` / `tts-end` — drive SPEAKING; tts-end → FOLLOWUP.
- `phone-connected` — reconcile: a fresh phone is IDLE, not speaking (fixes Bug #3
  at the boundary that actually means something).

## Events OUT (station → phone, "what to present")

- `present: { mode: idle|listening|thinking|speaking, beep: on|off|none }` —
  one frame the phone renders: face state + the on/off beep. The phone stops
  deciding; it shows what the station says. (The arbiter's PRIORITY logic moves
  here, or stays phone-side but is DRIVEN by station intent — open Q below.)

## Robustness (built-in, not patched)

- Every "on" state has an **expiry** (LISTENING/FOLLOWUP timeout, SPEAKING safety
  cap) — but tied to a real transition, reconciled on phone-connect.
- `speech-status` loss can't wedge it: SPEAKING is also bounded by turn lifecycle
  (the brain KNOWS when its own turn's TTS is done — it sent the speak frames) +
  reconciled on reconnect.

## OPEN QUESTIONS (need your call before I build)

1. **Where does the priority arbiter live?** Station-owned state machine is clean,
   but the phone needs *some* local logic for instant face/beep (no round-trip).
   Option A: station owns state, phone renders (one round-trip of latency on the
   beep). Option B: phone keeps the arbiter but it's a slave to station `present`
   frames. I lean **B** — phone renders instantly, station is the source of truth
   it syncs to.
2. **How big a rewrite?** This touches session.ts (state), index.ts (the latch +
   handlers), and PerceptionWiring (arbiter → renderer). Do it as ONE coherent
   change, or stage it (first unify the station's two state systems, then the
   phone)? I lean **staged**: (1) fold addressedLatch INTO session state on the
   station + reconcile-on-connect, (2) then make the phone a renderer.
3. **Keep the `ListeningArbiter`?** Its priority model is good + tested; it'd
   become the phone-side renderer of station intent. Reuse, don't discard.

## What I will NOT do
- No blind timeouts as the primary fix (the "hacky patch" you flagged).
- No more per-symptom patches — fix the ownership.
