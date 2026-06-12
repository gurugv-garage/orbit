# Server-side brain — moving the dock's agent loop to orbit-station

**Status: design + risk analysis (2026-06-11).** This is the exploration
behind moving the LLM agentic orchestration off the phone (node-dock/app, the
vendored Kotlin pi port) onto orbit-station (Node/TS, embedding the original
TypeScript [pi](https://github.com/earendil-works/pi)), with the phone
becoming perception + actuation. Companion to [plan.md](plan.md) §5/§10 and
[MEDIA-PROCESSING.md](MEDIA-PROCESSING.md).

> **Superseded in part (2026-06-12):** the production implementation plan is
> [SERVER-BRAIN-IMPL.md](SERVER-BRAIN-IMPL.md). Three decisions changed from
> the experiment framing below: it is a **full cutover with no Kotlin
> fallback** (no `brainMode` flag; the phone loop is deleted at cleanup);
> **reconnection handling is a first-class requirement** (designed and tested
> explicitly, not best-effort); and **the station drives the body directly**
> — the ESP32 becomes client-only (one WS server in the whole system), the
> `move` tool executes in-process at the station, and the phone never talks
> to the firmware (see the plan.md "One WebSocket server" decision). It is a
> big-bang cutover — no compatibility windows. The analysis, STT/TTS
> placement, and perf numbers below still stand (move-bearing turns get
> *faster* than analyzed: no tool RPC for motion). The §5 session model is
> also refined in the impl plan (§3.0): sessions become explicitly **bounded
> engagements** (lazy open, idle/explicit close → summary) under a per-dock
> tenancy model, decoupled from process and connection lifetimes — not the
> open-ended all-day session described below.

## 0. Decisions already made

- **Full cutover** (amended 2026-06-12 — was: flagged experiment). The
  phone's `DockAgent` loop, LLM transport, and prompt/tool schemas are
  replaced by the station brain and deleted; rollout is by app build (OTA),
  not a runtime flag.
- **Station dependency is accepted architecture**, not a risk to engineer
  around. The dock was always going to depend on the station; when the
  station is unreachable, the dock fails loudly (canned line + offline cue) —
  no local brain, no seamless failover. Reconnects must be clean and
  well-defined on both sides (see SERVER-BRAIN-IMPL.md §5).
- **STT/TTS stay on the phone for phase 1** (Option A in §6): transcripts up,
  sentence text down. Server media brain (Option B) is a later, separate
  decision, de-risked via shadow mode.
- **Streaming-first everywhere.** Every hop that can stream, streams: partial
  transcripts up while the user is still speaking, sentences down the moment
  they close mid-token-stream, tool calls dispatched as they parse. Latency is
  minimized by pipelining, never by batching at turn boundaries.

## 1. Why

The phone's loop works, but every brain iteration is an APK sideload; models
are limited to two hand-rolled transports (Ollama NDJSON + OpenAI SSE); API
keys ship inside the APK; conversation history dies with the app process; and
the station — which already runs face recognition and sees every dock — can't
contribute anything to the prompt. Per plan.md §10 ("move only when latency,
capability, or complexity force it"): **capability is the driver here** —
latency is roughly break-even (§7), and iteration speed, real providers,
durable sessions, and perception fusion are the wins.

The TS pi packages (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`,
MIT, actively maintained) are the original that `node-dock/app/agent-core` was
ported from — identical Turn/Step/event vocabulary, embeddable as a library,
with multi-provider streaming (Anthropic, Google, OpenAI, Bedrock,
openai-compatible/Ollama) that replaces `DockStreamFn` outright.

## 2. Architecture

A new station module — `server/src/modules/brain/` — owning a new `agent`
topic. **Not** an extension of `mind`: `mind`'s contract is a passive
bus-watcher; the brain is an actor with per-dock state. `mind` stays as-is.

```
phone (perception + actuation)            orbit-station
─────────────────────────────             ──────────────────────────────
mic → VAD/wake → Android STT  ──transcript/turn-request──►  brain module
PerceptionSnapshot, battery   ──context──────────────────►  ├ DockBrainSession (per dock)
camera JPEG (vision turns)    ──(in turn-request)────────►  │  ├ TS pi Agent (pi-ai transport)
                                                            │  ├ prompt builder + history hygiene
DockTools (set_face, move,    ◄─tool-call──────────────────┤  ├ sentence splitter (TS port)
 TTS enqueue, BodyLink servo)  ──tool-result──────────────►│  └ AbortController per turn
Android TTS                   ◄─speak (per sentence)───────┤
face UI state                 ◄─turn-status / cancelled────┤
                                                            ├ obs events → observability (in-process)
                                                            └ face tools → perception module (in-process)
```

- **`DockBrainSession`** — one per dock name, held in a `Map`. Embeds one pi
  `Agent`; created lazily on the first turn from an app peer in
  `brainMode=station`.
- **Dynamic system prompt** — phase 1 is parity with today's
  `DockAgent.runTurn`: ported `DockPrompt.SYSTEM` + `"\n\nCurrent state — "` +
  the perception-context string the phone sends in `turn-request`. Phase 2
  fuses the station's own perception state (presence/identity from
  `modules/perception/`) — the station often knows more than the phone.
- **History hygiene is non-negotiable.** Port `sanitizeHistory()` from
  `DockAgent.kt`: synthetic `"(interrupted)"` results for unanswered tool
  calls after a cancel, and the history cap cut at user-message boundaries.
  Without it, every post-interruption turn 400s on OpenAI-style endpoints —
  the exact bug family already fixed once on the phone.
- **Observability gets simpler.** The brain publishes `AgentEventDto`s
  directly on the `obs` bus topic in-process (`source: 'station'`); the
  observability module's ingest doesn't care where events come from. No
  per-token WS budget — every delta is free. The phone ships nothing to obs in
  station mode.
- **Face tools get faster.** `remember/recollect/confirm/forget_face` today
  round-trip phone→station→phone; in station mode they're in-process calls
  into the perception module (the phone only supplies the frame, attached to
  the turn or grabbed from the SFU in phase 2).

New files (station): `modules/brain/index.ts` (module wiring, session map,
`GET /api/brain/sessions`), `session.ts` (pi Agent, turn lifecycle, sanitation,
AbortController), `remote-tools.ts` (tool defs whose `execute()` is the RPC
below; face tools in-process), `rpc.ts` (reqId-matched promise map: directed
send, timeout, offline rejection), `sentence.ts` (TS port of
`StreamingReplyExtractor` + speech sanitation), `prompt.ts` (ported
`DockPrompt`).

Phone-side: extract a small `Brain` interface from `DockAgent`'s public
surface (`respond/stop/state/events`); new `RemoteBrain.kt` implementing it
over `StationLink` (subscribe `agent` topic, same callback pattern as
`onPerceptionFrame`); `brainMode` wiring through `ConfigCache`. `DockAgent`
untouched.

## 3. Wire protocol — topic `agent`

Reuses the proven directed `to:` + `reqId` request/response pattern from the
perception module (`recognize-request`/`recognize-result`). All frames are
ordinary `publish` frames on the one `/ws`.

```
phone → station (publish topic 'agent'):
  transcript    { turnId?, text, isFinal: false }    // streaming partials (pre-warm)
  turn-request  { turnId, trigger: {kind:'user', text},
                  context: { state: string, battery?: number },
                  imageBase64?, imageMime? }
  tool-result   { reqId, toolCallId, content: string, isError: boolean }
  turn-cancel   { turnId }                           // tap-to-stop
  context       { state, battery, ... }              // on-change + slow periodic

station → phone (bus publish, to: <app peer id>):
  tool-call     { reqId, toolCallId, turnId, name, args, timeoutMs }
  speak         { turnId, seq, text }                // one sentence per frame
  turn-status   { turnId, state: 'waiting'|'thinking'|'speaking'|'failed'|'done', detail? }
  cancelled     { turnId }
```

### Semantics

- **Fire-and-forget actuation is preserved.** Today's tools dispatch the
  servo move / TTS enqueue and return a status string immediately — the loop
  never blocks on actuation. The phone does exactly that on `tool-call`
  (dispatch into the existing `DockTools`, ack with the synchronous status),
  so each tool call costs **one LAN RTT, never servo-travel time**. No
  "awaited actuation" mode in phase 1.
- **Timeouts never hang the turn.** `timeoutMs` (default ~10s); on expiry the
  RPC resolves as an `isError` result `"(no response from dock)"` and the loop
  continues — the model can narrate the failure.
- **At-most-once.** Unique reqIds; the brain never retries a `tool-call` (a
  missed nod is fine, a doubled 30° servo move is not). The phone dedupes by
  reqId defensively.
- **Disconnect = abort.** The brain watches the dock roster; if the app peer
  drops mid-turn, all in-flight reqIds for that dock reject and the turn
  aborts (with history sanitation). The *session* survives (§5) — only the
  turn dies.
- **Cancellation.** Tap-to-stop does two things on the phone: (a)
  `tools.silence()` **locally, instantly** — perceived interruption latency is
  unchanged because shutting the mouth never crosses the network; (b) publish
  `turn-cancel`. The brain aborts the pi turn (AbortSignal), sanitizes
  history, replies `cancelled`. Three races to engineer:
  1. *In-flight `speak` frames after cancel* — the phone keeps the current
     turnId and drops frames for any stale turnId (epoch gating), so late
     sentences can't leak into the next turn's TTS.
  2. *Unanswered tool calls in server history* — `sanitizeHistory()` (above).
  3. *Lost cancel frame* — server-side turn ceiling (keep the 60s cap) as the
     backstop.

## 4. Streaming-first pipeline

The latency waterfall, user-stops-speaking → first audible word:

```
local mode (today)
  STT endpoint → final transcript ─► prompt build + camera grab ─► LLM TTFT (p50 1334ms)
    ─► tokens stream ─► first sentence closes (p50 +17ms) ─► TTS engine start (p50 141ms) ─► audio

station mode (designed)
  …user still speaking: partials stream up ─► brain PRE-WARMS
      (prompt built, perception context folded, provider connection warm)
  STT endpoint → final transcript ─► 1 hop up (~5–10ms) ─► LLM TTFT (wired station)
    ─► tokens stream ─► sentence closes ─► 1 hop down (~5–10ms) ─► TTS start (141ms) ─► audio
```

- **Up:** Android STT already emits partials; ship them as `transcript`
  frames. The brain uses them to do everything *except* fire the LLM call, so
  the call fires the instant the final lands — the pre-warm typically recovers
  more than the two added hops cost.
- **Down:** the sentence splitter runs on the token stream server-side;
  `speak` frames ship the moment a sentence closes, so phone TTS starts on
  sentence 1 while the LLM is still generating — same overlap as today, plus
  one LAN hop. Tool calls dispatch as soon as they parse from the stream,
  never held to step end.
- **Later (phase 3):** the same principle extends to media — *streaming*
  server STT (not utterance-final whisper) and chunked TTS audio downlink, if
  Option B ever wins (§6).

## 5. Sessions & profiles (pi-side management)

**Sessions.** One pi `Agent` per dock, keyed by dock name; long-lived by
design — a desk companion runs all day. Lifecycle:

- Created lazily on first turn; **dock-offline does not kill it** — history
  survives phone reconnects and app restarts, which is strictly better than
  today (phone process death loses everything).
- Explicit reset from the console (`POST /api/brain/:dock/reset`) → new
  sessionId; idle TTL only as a safety valve.
- Persistence: start with TS pi's harness `Session`/JSONL repo — it's built
  for exactly this and brings resume/branching for free. The station's sqlite
  (`core/db.ts`) is the fallback if the JSONL repo fights the module model.
- **Context growth:** the phone today blunt-trims to 48 messages. Server-side,
  use pi harness **compaction/summarization** (a background LLM call the
  station can afford) with trim-at-user-boundary as fallback. This is a real
  capability win, not just parity.
- **Obs mapping:** the pi sessionId becomes `AgentEventDto.sessionId` — one
  observability tree per dock-day instead of one per app launch.

**Profiles.** Per-dock agent configuration: model (pi-ai model id),
persona/system-prompt variant, enabled tools, vision gating, thinking level.
Keep these **station-config-native** — per-dock scoped keys in the existing
config registry (`brain.model`, `brain.persona`, …), editable live from the
console, applied on the next turn (model/prompt are per-call in pi, no session
restart). This replaces the phone's `ModelCatalog`, and **API keys move from
the APK's `local.properties` into station env** — a real security win. (Open
question noted and answered: don't adopt pi's own settings/profile files; the
config module already has push, persistence, and UI.)

## 6. STT/TTS placement

**Option A — stay on phone (phase 1, chosen).** Transcripts up, sentences
down. Adds ~2 hops + 1 RTT per tool call (~25–100ms/turn, §7) against a
multi-second LLM budget. Wake word, VAD endpointing, barge-in posture all
untouched. Zero new media work. Cons: STT quality stays Android
SpeechRecognizer; the server never sees raw audio (no diarization/emotion);
transcript-only debugging.

**Option B — server media brain.** Uplink is half-built: the SFU already
receives the dock's Opus and the `ProcessingHub` is a `MediaTap` designed for
an STT sidecar ([MEDIA-PROCESSING.md](MEDIA-PROCESSING.md)). But: server VAD
endpointing replaces Silero-on-device; wake word either stays on-device
(gating when audio "counts") or goes always-streaming (battery/privacy);
utterance-final whisper *loses* Android's streaming partials (~+300–800ms to
transcript-final unless a streaming STT is used); and **TTS downlink is
genuinely new work** — the SFU only fans dock→browser today (choices: werift
sendrecv downlink track > chunked Opus over WS > per-sentence HTTP clips).
Barge-in — already a known pain (AEC insufficient, barge-in disabled) — gets
strictly harder when the mic decision is remote.

**Path from A to B without betting the robot:** run **server STT in shadow
mode** — tap the existing SFU audio, transcribe in parallel, render both
transcripts in the console, compare quality/latency for weeks before any
authority switch. TTS downlink is a separate decision after that.

## 7. Perf analysis — measured, not guessed

From the station's observability store (`orbit-station/.data/orbit.db`): 320
turns, gemini-2.5-flash, phone on Wi-Fi, error turns excluded.

| Measured today (ms) | p50 | p90 | p99 |
|---|---|---|---|
| LLM TTFT (step start → first token) | 1334 | 5443 | 14288 |
| LLM stream after first token | 17 | 90 | 509 |
| Tool exec: `set_face` / `move` | 8 / 12 | 17 / 23 | 31 / 33 |
| Tool exec: `recollect_face` (already phone→station→phone) | 84 | 243 | 826 |
| Gap: tool end → next step start | 2 | 7 | 10 |
| Turn duration (n=315; 217/319 turns are 2-step) | 2455 | 11640 | 18834 |
| Speech-start lag after turn end (phone TTS engine) | 141 | 1469 | 5184 |

**Estimated station-mode delta** for the typical 2-step turn: transcript hop
up (~5–10ms) + 1–2 tool-call RTTs (~10–60ms LAN) + per-sentence speak hop
(~5–10ms, hidden behind TTS pipelining) ≈ **+25–100ms on a p50 of ~2455ms
(1–4%)** — noise against TTFT. Offsetting gains:

- `recollect_face` becomes in-process: **saves ~80–240ms** on the ~26% of tool
  calls that use it (83 of 236 measured).
- The LLM call moves from phone Wi-Fi to the wired station; the TTFT tail
  (p90 5.4s, p99 14.3s) plausibly includes Wi-Fi jitter, so **tails may
  improve**.
- Pre-warm on streamed partials (§4) can recover more than the added hops.

**Net claim: median roughly break-even, tails likely better.** The one new
exposure is Wi-Fi jitter on the `speak` downlink — sentence delivery to TTS is
in-process today and becomes a radio hop. Speech-start lag (141ms p50) is the
phone TTS engine and is unchanged either way. The verification phase must
re-measure this exact table in station mode on the same utterance set.

## 8. Risks & cons (honest list)

1. **Wi-Fi jitter on every hop.** LAN RTT is ~1–5ms, but phone power-save
   polling and channel scans spike to 100ms–1s. The recent
   interruption/latency bug family shows this system is sensitive to exactly
   this. Measure with obs `TurnSettled` distributions in both modes; don't
   guess.
2. **Interruption crosses the network.** Mitigated: silencing stays local and
   instant; only "stop generating" crosses. The three races in §3 must be
   engineered, not hoped away.
3. **Prompt/tool drift between Kotlin and TS — transitional only** (amended
   2026-06-12). With no Kotlin fallback, the TS `brain/` copy becomes the
   *only* copy once cleanup deletes the phone's `llm/` surface; drift exists
   only during the cutover window. Mitigation: port the Kotlin test vectors
   (sentence splitter, SafeCompute, tool schemas) to TS *before* writing new
   code — they are the spec — and keep the cutover window short
   (SERVER-BRAIN-IMPL.md §9).
4. **Distributed debugging.** A bad turn spans logcat + station logs + WS
   frames. Partly self-compensating (obs gets richer in-process; `agent`
   frames are visible in the console bus view); add turnId-scoped logging on
   both sides.
5. **Reconnect mid-turn.** App re-hello mid-turn kills in-flight directed
   frames; the brain must treat it as turn-abort, never retry actuation.
6. **Cloud-LLM dependency unchanged** — the station adds a hop in front of
   it, it doesn't remove it. (Local models keep working: pi-ai speaks
   openai-compatible to the same LAN Ollama box.)

(Station dependency itself is a property, not a risk — accepted, see §0.
Behavior when the station is unreachable in station mode: fail loudly, flip
the flag back to `local`.)

## 9. Pros

1. **Brain iteration without sideloading** — prompt/tool/loop changes become a
   server reload instead of `gradlew :app:installDebug` to a physical phone.
   The single biggest experiment-velocity win.
2. **Real providers via pi-ai** (Anthropic/Google/Bedrock/OpenAI native
   streaming) and **API keys out of the APK**.
3. **Face tools faster** (in-process), and the prompt can be grounded in
   station-side perception the phone never sees.
4. **Durable, compactable sessions** — history survives app restarts;
   compaction replaces blunt trimming; one obs tree per dock-day.
5. **Cross-dock memory becomes possible** — the multi-dock story effectively
   requires a central brain eventually.
6. **Phone battery/thermals** — no streaming LLM HTTP on the phone.

## 10. Phasing

- **Phase 0 — scaffolding (no behavior change):** `agent` topic in
  `protocol.ts`; `brainMode` config-registry entry + `ConfigCache` interest;
  `Brain` interface extraction on the phone.
- **Phase 1 — minimal experiment (Option A):** `modules/brain/` with pi-ai;
  `RemoteBrain.kt` + StationLink `agent` callback; obs from the bus; vision
  via JPEG-in-turn-request; face tools in-process.
- **Phase 2 — server-side advantages:** perception fusion in the prompt; SFU
  frame-grab for vision turns (no upload); persisted sessions + compaction;
  console brain panel.
- **Phase 3 — media brain (separate decision):** server STT shadow mode via
  the existing tap → console comparison → only then authority; TTS downlink
  design.

**Success criteria (write down before starting):** end-to-end `TurnSettled`
p50/p95 within ~200ms of local mode on LAN; interruption-to-silence unchanged
(it's local); zero post-interrupt turn failures over a 50-turn session;
subjective parity on the standard utterance set; the §7 table re-measured in
station mode.

## 11. Verification

- **Unit (station, `tsx --test`):** `rpc.test.ts` (timeout, disconnect, late
  result); `sentence.test.ts` (parity against the Kotlin
  `StreamingReplyExtractor` test vectors); `session.test.ts` with a faux
  StreamFn (cancel → sanitized history; tool error → loop continues).
- **Smoke:** new `server/src/dev/fake-phone.ts` (modeled on
  `smoke-client.ts`): a role-`app` peer that sends a scripted `turn-request`,
  answers every `tool-call` instantly, prints `speak` frames with timestamps —
  the full loop with no hardware. `npm run smoke:brain`.
- **Phone unit:** `RemoteBrainTest` against a fake StationLink (epoch gating,
  tool dispatch, dedupe).
- **Real phone on LAN:** flip `brainMode` from the console; run the standard
  utterance set; compare obs timelines local vs station; kill the station
  mid-turn; tap-to-stop mid-sentence.

## 12. Key files

| Where | File | Role |
|---|---|---|
| station | [`server/src/core/protocol.ts`](../orbit-station/server/src/core/protocol.ts) | add the `agent` topic; the wire contract |
| station | [`server/src/modules/perception/index.ts`](../orbit-station/server/src/modules/perception/index.ts) | the directed `reqId` RPC pattern to replicate; face tools to call in-process |
| station | [`server/src/modules/config/registry.ts`](../orbit-station/server/src/modules/config/registry.ts) | the `brainMode` flag |
| phone | [`DockAgent.kt`](../node-dock/app/app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt) | the loop being ported: prompt grounding, `sanitizeHistory`, sentence streaming, cancel semantics |
| phone | [`StationLink.kt`](../node-dock/app/app/src/main/kotlin/dev/orbit/dock/station/StationLink.kt) | WS plumbing to extend with the `agent` topic |
| upstream | [github.com/earendil-works/pi](https://github.com/earendil-works/pi) | `@earendil-works/pi-agent-core` + `pi-ai` (MIT) |
