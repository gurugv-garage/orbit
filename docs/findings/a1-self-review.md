# A1 self-review — issues I found in my own code (+ what I fixed)

> You asked me to review my own A1 code. I read the higher-risk pieces critically
> (the audio engine + the DockTts rewrite + the station wiring). Here's everything
> I found, what I fixed, and what I judged "acceptable by design" (with reasons so
> you can overrule).

## FIXED

1. **Multi-sentence playback timing (the real bug).** `DockTts.feedSynthesized`
   scheduled each utterance's "speaking ended" timer at `playMs` from *now*. But a
   reply's sentences synthesize near-simultaneously (seen in logs: 4 `synth done`
   in 60 ms) and play SEQUENTIALLY from the shared render queue — so all the timers
   fired at once while audio was still playing sentence 3 of 4, dropping the
   `speaking` signal early (face → Idle / gate thinks TTS ended mid-reply). Fix: a
   running playback clock (`playbackEndsAt`) — each utterance's end is scheduled
   relative to when the audio queued *ahead* of it finishes, not `now`.

2. **Orphaned synth WAV leak on barge-in.** If `stop()` landed between
   `synthesizeToFile` and `feedSynthesized`, the cached WAV was never read/deleted.
   Fix: `stop()` now deletes any pending `synthFiles` + resets the playback clock.

3. **Redundant store scans in the auto-summarizer wiring.** `activeDocks()` +
   `countFor(d)×N` each rebuilt the full per-dock count map (N+1 scans of up to
   ~1000 records per tick). Fix: memoize the count map for 1 s so one tick shares
   one scan. (Negligible for one dock, but it was sloppy.)

## ACCEPTABLE BY DESIGN (noted, not fixed — overrule if you disagree)

- **`TtsAecLoopback` has no teardown.** It holds 2 PeerConnections + a sender
  factory/ADM for the app's lifetime. This is intentional — it's created once
  (lazily) and reused for every utterance so playback needs no re-handshake;
  `WebRtcAudio` is a process-lifetime singleton anyway. The OS reclaims on death.
- **The sender ADM callback runs continuously** (zero-padding when idle). Required
  to keep the loopback stream alive between utterances. Negligible cost.
- **`drainTts` odd-byte split** — I checked: chunks are always even (resampler
  emits Shorts → even bytes) and WebRTC's `want` is frame-aligned (even), so a
  16-bit sample is never split. No fix needed; safe as-is.
- **Echo-gate self-healing tail** (`SPEAK_TAIL_MS`, finite window) — kept even
  though the gate is now default-OFF, as the fallback path's safety. Fine.

## NOT REVIEWED DEEPLY (lower risk / well-tested)

The pure logic (addressed correlator, shouldSummarize, thought-router) is small +
exhaustively unit-tested (16 + variants, repeated runs). The station transcript
hook + barge-in supersede ride existing, battle-tested paths (handleTurnRequest /
sanitizeHistory). I focused the review on the NEW, stateful, real-time code.

## Test status after the review fixes

Server 178/178 (×2), phone 128/128, barge-in 4 variants, auto-summarizer 8 —
all green, typecheck clean.
