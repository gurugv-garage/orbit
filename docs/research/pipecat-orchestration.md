# Pipecat as a conversation-orchestration base — fit assessment

> **RESEARCH STUDY** (2026-07-22). Question: can we adopt Pipecat
> (`pipecat-ai/pipecat`) as a hardened, drop-in base for the speech-to-speech
> conversation loop — interruptions, turn-taking, steering, tool calls,
> thinking/waiting states, TTS queueing — instead of the hand-rolled
> orchestration we keep fixing? What can we plug in incrementally, and what does
> it cost us?
> Method: deep-research harness (5 search angles → source fetch → 3-vote
> adversarial verification). 18 claims fully verified (votes shown); ~4
> rate-limited before their third vote (marked UNVERIFIED — single credible
> source, treat as leads). The synthesis is hand-written from the surviving
> evidence + our own orchestration map (§2).
>
> Consumers: [brain](../../orbit-station/server/src/modules/brain/) (session +
> barge-in engine + conversation-state), [perception speech
> path](../../orbit-station/server/src/modules/perception/processors/),
> [node-dock RemoteBrain/DockTts](../../node-dock/app/). Related:
> [perception-pipeline](../perception-pipeline.md),
> [perception-to-brain](../perception-to-brain.md),
> [server-brain-impl](../decision-traces/server-brain-impl.md),
> [barge RCA](../rca/2026-07-21-barge-stop-continues.md),
> [should-respond-gate memory](../../).

## TL;DR

Pipecat solves **exactly the class of problem we keep fixing** — barge-in
cancellation, turn endpointing, TTS-queue flushing, thinking/tool-call states —
and it solves it as *architecture* (typed frames on a priority queue), not as
app code we bolt on. Its extension seams fit our stack unusually well: custom
STT is a one-method subclass (upstream already has an MLX-Whisper precedent, and
Modal has run **Parakeet-tdt** under Pipecat at ~1s voice-to-voice); any
OpenAI-compatible LLM plugs in via `base_url`; the smart-turn model is a
BSD-2, ~8M-param, sub-100ms-CPU end-of-turn detector we could even adopt
*standalone* without the rest of the framework.

**But it is not a drop-in for our shape.** Two hard mismatches:

1. **Python-only agent runtime, GIL-bound, one-process-per-session.** Our brain
   (pi agent loop, tools, sessions, obs traces) is TypeScript in one station
   process. Pipecat can't host that loop — it would run as a **per-dock sidecar
   process** owning *only* the audio/turn loop, with our LLM+tools reached over
   its custom-LLM seam. That's a real architectural split, not a library import.

2. **Pipecat wants to own the audio transport too** (its WebRTC/WebSocket
   transports, RTVI client protocol, its own Android SDK). Our phone is already
   a mature pure-renderer on our own WS protocol, and our audio already flows
   phone → **media SFU tap** → PCM. Adopting Pipecat's transport means
   re-plumbing the dock; keeping ours means feeding Pipecat raw PCM through a
   custom transport/serializer and re-emitting its output frames as our existing
   `agent`-topic frames.

**Verdict: adopt the *ideas and the isolable components* first, not the whole
runtime.** The single highest-value, lowest-risk move is to lift the
**smart-turn model** into our EOU/`should-respond` work (it's standalone, BSD-2,
CPU-fast, and squarely on our open turn-taking problem). The second is to steal
Pipecat's **frame-type interruption discipline** — SystemFrames on a priority
lane, DataFrames discardable — as the redesign target for our four tangled state
machines, whether or not we ever run their code. A full Pipecat sidecar is a
plausible *phase 3*, but only if we accept the process-split and either adopt
RTVI on the phone or write a custom PCM transport. Don't expect "plug it in and
the barge-in bugs vanish" — Pipecat has its own documented barge-in sharp edges
(TTS-flush races, VAD backchannel false-triggers, a pipeline-freeze on
interrupt-during-context). It gives a **better-factored base to fix on**, not a
finished solution.

## 1. What Pipecat actually is (verified)

**Frame/processor pipeline.** The core is a linked list of `FrameProcessor`s;
each consumes one frame and emits zero or more, flowing `DOWNSTREAM`
(input→output) and `UPSTREAM` (output→input). Processors range from trivial
transforms (text→sentences) to AI services (LLM, STT, TTS). *(3-0)*

**Interruption is a first-class, type-level primitive — the part we care about
most.** Frames are typed into three bases with baked-in interruption semantics:
- `SystemFrame` — higher priority, handled on a **separate priority task**, *not*
  cancelled by user interruptions (e.g. `InterruptionFrame`,
  `UserStartedSpeakingFrame`, `InputAudioRawFrame`, `ErrorFrame`).
- `DataFrame` / `ControlFrame` — queued and processed **in order**, and
  **cancelled by user interruptions** (e.g. `OutputAudioRawFrame`,
  `TTSTextFrame`, `LLMTextFrame`, `EndFrame`). *(3-0, 3-0)*

So barge-in is a mechanism, not app logic: `broadcast_interruption()` pushes an
`InterruptionFrame` both up and downstream; queued TTS/LLM output frames are the
discardable path; an `UninterruptibleFrame` marker lets specific frames survive.
*(3-0, 3-0)* This is precisely the discipline our barge engine lacks — our
`tts-hold`/`resume`/`yield` decision is decoupled from the stop-decision, which
is the root cause in the [2026-07-21 barge RCA](../rca/2026-07-21-barge-stop-continues.md).

**Tool calls + thinking/waiting as frames.** Function calls are explicit frames
(`FunctionCallsStartedFrame`, `FunctionCallResultFrame`) and internal reasoning
has dedicated `LLMThoughtStart/Text/EndFrame`. *(3-0)* Thinking/waiting UX can be
driven straight off the frame stream — the equivalent of our `turn-status`
(thinking/acting) frames, but native.

**Smart-turn (this is the gem).** An ML end-of-turn model layered on Silero VAD:
on a VAD pause it analyzes the last ~8s of user audio using prosody/intonation
(not transcript) to decide complete-vs-incomplete, with a `stop_secs` silence
fallback. *(3-0, 3-0)* `LocalSmartTurnAnalyzerV3`: ONNX, local CPU, **~8M params
(Whisper-Tiny base + linear head), 8MB int8, ~10-100ms CPU, 23 languages,
BSD-2-Clause, open training data**, default user-turn-stop strategy since
v0.0.102. *(3-0, 3-0, 3-0)* It's a **standalone repo** (`pipecat-ai/smart-turn`) —
usable independently of the framework. This maps directly onto our
[should-respond-gate](../../) and parked [STT-EOU POC](../../): our finding was
that off-the-shelf 0.3-0.6B LMs are ≈random zero-shot and *must* be fine-tuned —
smart-turn is a purpose-built, tiny, already-trained model for exactly this.

**Extensibility seams (all verified):**
- **Custom STT** = subclass `STTService`, implement one async `run_stt(audio)`
  that yields frames; you inherit mute-gating, TTFB + speech-end-to-final
  metrics for free. A `SegmentedSTTService` variant runs STT only on
  VAD-detected segments — suits file/segment models like **parakeet**. *(3-0,
  3-0)* Upstream precedent: `WhisperSTTServiceMLX` (Apple-Silicon Metal) is a
  small subclass merged from a community contributor. **Modal ran Parakeet-tdt +
  Qwen3-4B/vLLM + Kokoro under Pipecat at median ~1s voice-to-voice.** *(verified
  lead)*
- **Custom LLM** = `OpenAILLMService` takes `base_url`; any OpenAI-compatible
  endpoint (Ollama, OpenRouter, Mistral, Together) inherits streaming + function
  calling + context mgmt. Our OpenRouter/Gemini mix maps to thin subclasses.
  Resilience controls exist (`retry_on_timeout`, `on_completion_timeout`,
  `on_function_calls_started`). *(verified lead)*
- **Custom processors** = subclass `FrameProcessor`, override `process_frame`,
  forward with `push_frame`; maintainers document inserting custom stages
  between STT→LLM→TTS. Production-grade extensions exist (VoicemailDetector via
  ParallelPipeline+ClassifierGate, DTMF aggregator, IVR navigator). *(3-0)*

**Transport / Daily / Android:**
- **Daily is NOT required.** It's the *reference* transport; the framework is
  vendor-neutral. `SmallWebRTCTransport` (Python aiortc) is serverless — clients
  connect direct to the agent, no WebRTC server. `FastAPIWebsocketTransport`
  gives plain bidirectional-audio WebSocket. *(3-0, 3-0)*
- **Android SDK exists, first-party, Kotlin, BSD-2** — `pipecat-client-android`,
  implements the open **RTVI** protocol, transport-agnostic (Daily / SmallWebRTC
  / WS / Gemini-Live / OpenAI-Realtime as separate libs). Core client reached
  **1.0.0** on Maven Central; the SmallWebRTC transport artifact is **0.3.7**
  (pre-1.0). Repo is small/lightly-adopted (~29★, 2 releases) — official but
  early. *(3-0, 3-0)*

**Runtime / language:** **Python-only agent runtime.** Node.js support is cited
as a *LiveKit-Agents advantage over Pipecat*. Scaling model is **one container =
one session = one Python process** due to the GIL. Local STT via optional extras
(`pipecat-ai[mlx-whisper]`). *(verified lead)* → For our TS station this means a
**per-dock sidecar process**, not an in-process library.

**Maturity / license:** Core is **BSD-2-Clause**, near-daily development, richest
prebuilt-integration ecosystem of the three main frameworks; active maintainer
workflow merging third-party provider PRs. Comparable GitHub adoption to LiveKit
Agents and TEN — no clear maturity winner. *(verified)*

## 1b. The sharp edges (don't skip these)

Pipecat is hardened, not magic. Verified/near-verified failure modes — several
mirror our own bugs, which cuts both ways (it means they're *hard*, not that
Pipecat has escaped them):
- **TTS-queue interruption races** (issue #950): with long LLM completions,
  already-queued text frames kept synthesizing *after* the interrupt — the
  ElevenLabs/PlayHT **WebSocket** TTS variants specifically. Fixed by
  disconnect+reconnect of the TTS websocket on interrupt (PR #719/#1272), with
  context-ID tracking as the long-term design. Cartesia-WS and all HTTP TTS were
  fine. **This is literally our "pauses then CONTINUES" bug** — evidence it's an
  intrinsic hard problem, and that Pipecat's fix is a specific flush, not a
  clean abstraction win. *(3-0)*
- **Pipeline freeze on interrupt-during-context** (issue #2567): `StartInterruptionFrame`
  arriving while the OpenAI context is processing froze the pipeline with no
  recovery. **VAD backchannel false-triggers** ('mhm', 'uh-huh') cause unwanted
  bot interruptions (issue #1084) — the exact clap/backchannel class we already
  fought. *(verified lead)*
- **SmallWebRTC audio regression** to "robotic/choppy" from v0.0.62 (#1530);
  some WebSocket provider integrations **die silently after ~60-70s of silence
  with no reconnection logic**. *(verified lead)* Our `publishCritical` vs
  `publish` + keepalive discipline is exactly this class of concern — we'd have
  to re-earn it inside Pipecat.
- Practitioner consensus (WebRTC veteran, HN, production war-stories): "with
  Pipecat **you'll spend a lot of time getting turn-taking right**"; a 26-issue
  production catalog (latency, memory leaks, VAD, pipeline freezes; the gotcha
  that `audio_in_sample_rate=8000` silently breaks Smart-Turn v3). *(verified
  leads)*

## 1c. Alternatives, briefly (verified where noted)

- **LiveKit Agents** — has a **Node.js SDK** (the one thing Pipecat lacks for
  us), and *adaptive interruption* that distinguishes true barge-ins from
  backchannels acoustically — but that feature is **coupled to LiveKit Cloud**
  (auto-enabled only on Cloud/dev, needs VAD + non-realtime LLM + aligned-STT).
  Ships faster, **least flexible / simplest topologies** of the three. *(verified)*
- **TEN** — most flexible, lowest-level: multi-language sub-processes
  (C++/Python/Go) wired by a JSON graph. Most power, most to build. *(verified)*
- **Vocode** — not surfaced with strong recent signal; treat as the lighter,
  less-active option.
- No clear maturity winner among the three on stars/activity. Pipecat's edge is
  **ecosystem breadth + the standalone smart-turn model**; its weakness for us is
  **Python-only**.

## 2. Our current orchestration surface (the thing we'd replace)

Split brain-in-station / renderer-on-phone, joined by a topic-based WS protocol.
Orchestration-relevant LOC:

| Tier | Concern | Key files | LOC |
|---|---|---|---|
| Brain | turn lifecycle + `#sendToVoice` + busy-drain | `brain/session.ts` | ~2078 |
| Brain | barge-hold engine (`bargeHolds`/`resolveBargeHold`, resume/cancelled/**yield**) + wire | `brain/index.ts` | ~1747 |
| Brain | mode state machine (idle/listening/thinking/speaking/followup) | `brain/conversation-state.ts` | 496 |
| Brain | busy-queue / speech-gate / addressed-latch / stop-intent / sentence-chunk | `brain/{busy-queue,speech-gate,addressed,stop-intent,sentence}.ts` | ~530 |
| Perception | STT + addressed + echo-gate + confidence tiers | `perception/processors/speech-watch.ts` | ~802 |
| Perception | VAD endpoint + **barge onset** (`onSpeechStart`) | `perception/processors/vad-endpoint.ts` | 553 |
| Perception | STT sidecar supervisor (parakeet :8078) | `perception/sidecars.ts` | 171 |
| Dock | frame renderer (RemoteBrain) | `app/.../agent/RemoteBrain.kt` | ~1089 |
| Dock | TTS queue + polite-pause PCM drain | `app/.../tts/DockTts.kt` | 549 |
| Dock | speaking-edge signal | `app/.../tts/SpeakingEdgeGate.kt` | 71 |

**Four independent state machines** currently co-own turn behavior:
`ConversationState` (mode) + `BusyQueue` (deferred utterances) + `SpeechGate`
(move barriers) + the inline `bargeHolds`/`bargeCooldownUntil` maps. Pipecat's
value proposition is collapsing these into one frame-priority discipline.

**Audio flow:** dock mic → WebRTC uplink → station **media SFU** →
`PerceptionProcessingHub` tap → `speechWatchProcessor` (Opus RTP → opusscript →
16 kHz mono PCM) → VAD endpoint → POST base64 PCM to **parakeet MLX sidecar
:8078**. VAD onset → `onSpeechStart` → barge-hold.

## 3. Where Pipecat would splice in (seams, cleanest → deepest)

1. **STT sidecar HTTP boundary** (`speech-watch.ts` `transcribe()` → `:8078`).
   Cleanest *input* seam.
2. **Perception→brain transcript API** (`getTranscriptApi()`: `onFinal`,
   `onSpeechStart`). Every final + every barge onset flows through these two
   callbacks — the fan-in an external turn-taker would receive.
3. **`onAddressedFinal`** (`brain/index.ts`) — the one function every addressed
   final lands in to become a turn.
4. **`#sendToVoice` + `agent`-topic frames** (`speak`, `turn-status`,
   `tts-hold`, `cancelled`, `tool-call`). The *output* seam — an orchestrator
   emits these to drive the **unchanged phone renderer**.
5. **The barge-hold engine** — Pipecat's native territory; owning it means owning
   `tts-hold` emission + resume/cancelled/yield, fed by `stop-intent.ts`.
6. **`DockTts.pause()/resume()` ↔ `WebRtcAudio.pauseTtsRender`** — the phone
   rendering primitive any orchestrator must preserve.

Highest-leverage bracket: **(2) `onFinal`/`onSpeechStart` in, (4)
`agent`-frames out** — together they fence exactly the orchestration you'd hand
to Pipecat, leaving SFU/mic uplink and phone renderer intact on either side.

## 4. Recommended path — incremental, reversible

**Phase 0 (do regardless of adoption): steal smart-turn.** Pull
`pipecat-ai/smart-turn` (BSD-2, standalone, CPU ~10-100ms) into the
[should-respond / EOU](../../) work as a proper endpointer/turn-completion
signal beside our VAD. This is the single best ROI: it's the exact model class
our bench said we'd have to fine-tune ourselves, it needs no Pipecat runtime, and
it plugs at the `vad-endpoint.ts` / STT-boundary seam. **Watch the 16kHz
requirement** (8kHz silently breaks it).

**Phase 1: adopt the interruption *discipline*, not the code.** Redesign our
barge path to Pipecat's model — a priority "system" lane (onset, stop-intent,
interrupt) that is *decoupled from and preempts* the discardable TTS/LLM output
lane, so a stop-decision and the pause it triggers can never desync (the RCA
root cause). This is a refactor of `session.ts`/`index.ts`/`DockTts` toward one
discipline, collapsing the four state machines. Buys most of the reliability win
with zero new runtime.

**Phase 2 (optional spike): Pipecat sidecar behind the two seams.** Stand up a
per-dock Pipecat Python process that: consumes our SFU PCM via a **custom
`FrameProcessor`/transport** (not their WebRTC — keep our uplink), runs
smart-turn + our parakeet as a `SegmentedSTTService` subclass, reaches our
**TS brain/tools over the `base_url` custom-LLM seam** (or as a custom LLM
service RPC-ing into pi), and re-emits `speak`/`turn-status`/`tts-hold` as our
`agent`-topic frames to the untouched phone renderer. Prove barge-in +
tool-call + thinking on **one dock** against the `stress-dock-pipeline` /
`two-dock-converse` skills before believing it. Accept the **process-per-dock**
cost and that our pi loop stays in TS *outside* Pipecat.

**Phase 3 (only if Phase 2 wins decisively): consider RTVI on the phone.**
Swapping our renderer for `pipecat-client-android` (RTVI) would let Pipecat own
end-to-end, but throws away a mature pure-renderer and our WS critical/telemetry
split. High cost; revisit only with strong Phase-2 evidence. The SmallWebRTC
Android transport is pre-1.0 (0.3.7) — not yet a safe bet under a real dock.

**What NOT to do:** don't rip out the TS brain to fit Pipecat's Python runtime,
and don't expect adoption to *delete* the barge-in class of bug — Pipecat has its
own (§1b). It gives a better-factored base to fix on. The reliability comes from
**the discipline (Phase 1) + the turn model (Phase 0)**, both of which we can
have without running a line of Pipecat.

## Sources (primary, verified)

- Pipecat FrameProcessor API — reference-server.pipecat.ai `.../frame_processor.html`
- Pipecat frames taxonomy — reference-server.pipecat.ai `.../frames.frames.html`
- Pipeline & Frame Processing guide — docs.pipecat.ai `/guides/learn/pipeline`
- Smart-Turn overview — docs.pipecat.ai `.../turn-detection/smart-turn-overview`
- `pipecat-ai/smart-turn` (model repo, BSD-2)
- STTService base class — reference-server.pipecat.ai `.../stt_service.html`
- Android client SDK — `pipecat-ai/pipecat-client-android`; SmallWebRTC transport docs
- OpenAI/compatible LLM service — docs.pipecat.ai `/server/services/llm/openai`
- Interruption sharp edges — GitHub issues #950, #2567, #1084, #1530; PR #719/#1272/#1383
- Framework comparison — Garcia (LiveKit/Pipecat/TEN); dev.to RoomKit/Pipecat/TEN/LiveKit
- Production war-stories — luonghongthuan.com "26+ real issues"; Modal self-hosted Parakeet+Qwen+Kokoro ~1s

<!-- verification note: 18 claims 3-0; ~4 UNVERIFIED single-source leads (MLX-Whisper
     subclass, OpenAI base_url provider, streaming/function-calling) rate-limited before
     3rd vote — credible primary sources, treated as leads. -->
