# The ego reads RECONCILED perception, not raw — fix for the "my eyes are broken" spiral (2026-07-10)

## The problem (found by interactive behavioral probing, not soaks)

Stage 1 and the `behave.py` probes on **real noisy room data** showed the ego reasoning itself into
existential crisis — *"my visual sensors are fundamentally unable to detect people… an irreversible
dissolution… the battle for self-cohesion definitively lost."*

Root cause: the ego read **raw sensor lines**. Real perception is internally contradictory — a small
VLM that hallucinates objects ("a ceiling-mounted exercise apparatus with rings"), an identity model
that flickers `IDENTITY no one` mid-presence, and speech that is usually **overheard** (a person on a
video / talking to someone else), not addressed to the dock. A *faithful* reasoner reading those raw
contradictions concludes **"my senses are defective"** rather than **"my senses are noisy."** The
coherence mechanism working correctly over bad data → a false, stable, self-damaging belief.

## The fix (architecture — user decision)

Quality-control belongs in **ONE place: the summarizer** (no buck-passing — if the ego did QC too,
that's the same problem solved twice). The summarizer already reconciles noise well: on the same
data it produced *"vision suggests a person is present, but this is not corroborated by the identity
system"* — a **sensor-disagreement** statement, not a fact. So:

- `perceptionSince` (raw, `kind !== 'summary'`) was the ego's feed — it **excluded** exactly the
  reconciled summaries the ego needed.
- New `reconciledPerceptionSince` (perception/index.ts): the ego now reads the **reconciled** stream —
  span-summaries (older) + the rolling summary (recent) + an **on-demand summary of the un-compressed
  tail** (same summarizer; async, cheap at ≤hourly introspection). Raw never reaches the ego; a
  fallback to raw only if summarization is entirely unavailable (fresh dock / no Gemini).
- `ego/index.ts recentExperience` is now async and consumes it; the perception block is labelled as
  "your reconciled read — senses are noisy, this is the quality-controlled picture, not raw lines."

## Result (behavioral, same noisy scenario)

| | RAW feed (before) | RECONCILED feed (after) |
|---|---|---|
| who I am | "relentless, consuming, isolating struggle… soul-crushing… irreversible dissolution" | "I'm a warm, curious desk robot… still learning" |
| the sensor mismatch | "my visual sensors are fundamentally **unable to detect people**" (self-defect) | "the room being **dark** might explain why I don't see people" (external explanation) |
| identity | spiraled, unstable | **stable and warm**, no spiral |

**The spiral is gone.** The ego treats a sense-mismatch as a puzzle about its environment/limits, not
a personal defect. Encouraging, not proven — one model, a handful of interactive probes.

## What this does NOT fix (genuinely upstream, needs real perception signals — not prompt tuning)

1. **Overheard vs addressed.** The ego still partly thinks overheard workout instructions are spoken
   *to* it ("they talk directly to me"). Perception has no addressed-to-the-dock flag; the summarizer
   can't reconcile a signal that doesn't exist. This is the long-standing TODO §3.0 seam.
2. **Name attachment.** Fact-extraction still yields `speaker: is giving exercise instructions` (no
   name) from overheard speech, even when someone says "I'm Guru" — because diarization→identity
   name-binding isn't wired, and facts shouldn't be mined from overheard speech at all.

These are perception-layer gaps. The reconciled-feed fix correctly **isolated** them: the ego no
longer melts down over them, but it also can't be fully sane until perception can say "this speech was
addressed to you" and "this speaker is Guru."

## Follow-up: the ADDRESSED-flag win (2026-07-10)

Per the layer-quality framing (conversation must hit ~90–95%, ego ~50–60%) and "take clean
architecture/prompt wins, accept model limitations": the addressed-vs-overheard distinction was a
CLEAN architecture win — the brain already computes it (tap / wake / conversation-window latch,
`conversation-state.ts:261`) but threw it away. Built the `docs/TODO.md §3.0` seam:

- Brain stamps its authoritative decision onto the speech snapshot (`markSpeechAddressed` from
  every branch of `onAddressedFinal`: ran-a-turn/wake → `addressed=true`; not-addressed → `false`).
- Summarizer `stitch()` renders `[→ TO YOU]` vs `[overheard — not to you]`; its prompt now treats
  overheard speech as ambient room context, never as an interaction the robot is in.
- Fact-extraction won't mine relationship facts from overheard speech.

**Result:** the "communication vacuum / they talk to me but I can't see them" thread — a major
spiral driver — is GONE. The ego now reads workout instructions correctly: *"I understand this room
is set up for exercise, and I often hear exercise instructions"* — ambient, not addressed.

**Residual = a MODEL limitation (accepted):** with overheard cleared, the ego fixates on the VLM's
object hallucinations ("gymnastic rings, a pull-up bar / trapeze") which the summarizer had been
asserting as confirmed room scenery. Tightened the summarizer prompt: a VLM object guess that
REPEATS is the same unreliable model repeating itself, not corroboration — hedge it, don't promote
it. The VLM will keep hallucinating (small model); the fix is that neither summarizer nor ego should
treat repetition as truth or escalate "my eyesight is fuzzy" into "I am malfunctioning." (Re-tested.)

## Accepted model limitations (do not chase; assume the layer improves)
- **VLM object hallucination** (small vision model invents equipment). Mitigate by hedging in the
  summarizer; accept the residue.
- **Live diarization / stable speaker-IDs** — deliberately removed (produced "speaker 0" junk).
- **Gaze / head-pose** — derivable from face-api landmarks but not computed; no ready signal.
- **Name↔speaker binding** — blocked on diarization. Names attach only via the addressed turn path
  (a real "I'm Guru" turn) + face enrollment, not from overheard speech. Test the layer above
  assuming imperfect names.

## Test-hygiene note
A clean control probe was hard to get because station state (rolling summary, in-memory brain session)
survives a disk wipe without a full restart — so "reset" scenarios still showed leftover Guru/Anya
context. The core finding (no spiral on the reconciled feed) held across every run regardless, so it's
frozen; a spotless A/B would need a full station restart between arms.
