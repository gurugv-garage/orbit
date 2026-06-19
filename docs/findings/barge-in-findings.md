# Voice barge-in on node-dock — the solved approach

**Status:** the hard problem is **SOLVED on-device** (no server). Proven, not yet
productionized. This doc records the architecture so it can be built cleanly.

## The problem

The dock's speaker is centimeters from its mic, so its own TTS reaches the mic
*louder* than the user. To barge-in (talk over the dock), the dock must detect
the user's voice while it's speaking — which requires cancelling its own voice
from the mic well enough that VAD only fires on the user. The phone's **hardware
AEC is too weak**: it leaves the dock's voice as **clearly intelligible speech**
in the mic (verified by ear), so VAD fires on the dock itself → self-interrupt.

## Why hardware AEC fails, and what fixes it

Echo cancellation needs a **reference signal** — a clean copy of "what am I
playing." The phone's hardware AEC has to *guess* the reference from the mic
alone (TTS plays via Android `TextToSpeech` → speaker, outside WebRTC). Weak.

**WebRTC's software AEC (AEC3) is far stronger — IF it gets the reference.** It
gets the reference automatically when the audio is **played through WebRTC's own
render path**. So the fix: route TTS *through* WebRTC so its render is the AEC
reference, and capture the mic through the same WebRTC ADM.

## The on-device architecture (PROVEN — see EchoLoopTest.kt)

No server needed. A **local loopback** of two PeerConnections, in-process:

```
 TTS PCM ──► [senderADM.AudioBufferCallback overwrites the captured buffer with
              TTS] ──► pcA (factory fTts) ──audio track──►  loopback
                                                              │
 pcB (factory fAec) ◄─────────────────────────────────────────┘
   • renders the received TTS through fAec's ADM → out the speaker
   • that render is the AEC REFERENCE
   • fAec's ADM also captures the real mic (software AEC on, HW AEC off)
   • SamplesReadyCallback → the AEC'd mic (what VAD would see)
```

### Key implementation facts (all validated on a Redmi 6 Pro)

- **Loopback works**: two PeerConnections peer in-process, no network/STUN.
- **Render-through-WebRTC works**: the received track plays out the speaker
  (heard by ear).
- **PCM injection point**: `JavaAudioDeviceModule.Builder.setAudioBufferCallback`
  — `onBuffer(ByteBuffer, …)` lets you **overwrite the captured buffer** before
  WebRTC reads it (verified in bytecode: the same buffer is passed to
  `nativeDataIsRecorded`). This is how TTS becomes the sent track.
- **Two factories are required**: one ADM injects TTS (sender), a separate ADM
  captures real mic + renders TTS as reference (AEC). They can't share one ADM
  because injection overwrites that ADM's mic.
- **Cross-factory deadlock fix**: never call one PeerConnection from the other's
  native signaling-thread callback — marshal **all** SDP/ICE calls onto a single
  neutral executor, or it hangs natively in `setRemoteDescription`.
- **Capture won't start unless pcB also sends a track**: pcB must `addTrack` a
  mic track so its ADM actually begins capturing (a receive-only PC never starts
  recording).
- **Force software AEC**: `setUseHardwareAcousticEchoCanceler(false)` so WebRTC's
  AEC3 runs instead of the weak hardware one.

### The result (measured)

8 s of the dock speaking, user silent, mic recorded:

| | peak | overall RMS | by ear |
|---|---|---|---|
| Hardware AEC (`mic-residual.wav`) | 0.541 | 0.0383 | **clearly intelligible** |
| TTS-through-WebRTC (`echo-loop-residual.wav`) | **0.088** | **0.0072** | **unintelligible / much fainter** |

~6× lower peak, ~5× lower RMS, and the dock's voice is no longer recognizable
speech → VAD won't fire on it → **barge-in stops self-interrupting**.

## What's left: productionize

Make the dock's **real** TTS + mic run through this loopback permanently (not
just the test):
1. Route live `DockTts` audio into the sender ADM's `AudioBufferCallback` as a
   PCM stream (instead of `TextToSpeech` → speaker). Keep it streaming
   (per-sentence) to preserve responsiveness.
2. Feed the AEC'd mic from `fAec`'s `SamplesReadyCallback` into the existing
   `MicCapture` → VAD path (replacing the current `WebRtcAudio` single-ADM).
3. The existing VAD-during-TTS barge-in trigger (PerceptionPipeline.runVad) then
   works as designed — now that the dock's voice is cancelled below VAD's
   threshold.
4. Re-run the automated self-interrupt test (AecSelfTest) — should pass at real
   reply volume now.

Debug harness lives in `EchoLoopTest.kt` + `LoopbackProbe.kt`
(`adb shell am broadcast -a dev.orbit.dock.ECHO_LOOP` / `…LOOPBACK_PROBE`).
