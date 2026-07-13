# Audio enricher — the merged, context-aware audio path

> **DECISION TRACE — BUILT 2026-07-12.** The two separate bg-audio calls (the
> per-utterance *speech-details* patch + the per-impulse *sound* record) were merged
> into ONE context-aware pass — the **audio enricher** — whose primary job is accurate,
> coherent, in-context transcription with diarization, and which also carries the acoustic
> read (kind/salience/summary/addressed) on the same record. This replaces the old path
> entirely (enricher-only; parakeet is now live-only). As built:
> [`audio-enricher.ts`](../../orbit-station/server/src/modules/perception/processors/audio-enricher.ts)
> (`enrichAudio` + `coalesceSegments`), the dual-path batch trigger in
> [`vad-endpoint.ts`](../../orbit-station/server/src/modules/perception/processors/vad-endpoint.ts),
> the wiring + memory-arm dedup in
> [`speech-watch.ts`](../../orbit-station/server/src/modules/perception/processors/speech-watch.ts)
> and [`perception/index.ts`](../../orbit-station/server/src/modules/perception/index.ts),
> the capture A/B backend in [`capture/online-stt.ts`](../../orbit-station/server/src/modules/capture/online-stt.ts),
> and the Studio UI (enriched lane + confidence pills + debug line + full-JSON expander).

## Why merge the two paths

The old design had two eager online calls sharing one `interpretAudio()`:
- **speech-details** — on every endpointed utterance, patch the speech record with kind/
  salience/summary/addressed (+ a transcript upgrade).
- **sound** — on every impulse/sustained acoustic trigger, land a standalone `sound` record.

Two calls per event is wasteful, and the *transcript* was still the reflex parakeet text
(garbled far-field STT — "potassium cave, spassium C air"). The goal: **one debounced call
that produces the authoritative, coherent transcript for the durable record**, in context,
with diarization and the acoustic read all on one packet. Parakeet stays live-only (fast
path for the addressed-latch / wake / console caption); the enricher owns durable memory.

## Trigger (dual-path batching)

> **UPDATED 2026-07-13.** The original single "armed + quiet" trigger became **two independent
> paths** so a short utterance closes fast while ambient sound is buffered long. The window is
> always cut **at an endpoint boundary** (a word is never split); the remainder carries to the
> next batch (no miss, no overlap). As built in
> [`vad-endpoint.ts`](../../orbit-station/server/src/modules/perception/processors/vad-endpoint.ts).

Two paths fire the enricher, and each stamps the record with **`armedBy` — the CAUSE, not the
content** (an acoustic-triggered clip may still contain speech, and that's fine):

- **Path A — speech** (`armedBy:'speech'`). **Parakeet** (not the energy VAD) drives this: after
  transcription, `speechEndpoint(hasWords)` arms the fast path only when parakeet returned
  *substantive* words (≥2 alphanumeric chars, non-garbage tier — so far-field noise can't arm it).
  The clip fires `PERCEPTION_SPEECH_INACTIVITY_MS` (3 s) after the last real-speech endpoint —
  short natural utterance, closes shortly after you stop talking.
- **Path B — acoustic** (`armedBy:'acoustic'`). A non-speech acoustic event (impulse/sustained from
  the RMS `AudioTrigger`) opens a `PERCEPTION_ACOUSTIC_WINDOW_MS` (30 s) window **anchored at the
  first event**; further acoustic events don't extend it (continuous sound → back-to-back windows).
  Speech **overrides** an open acoustic window: the clip START stays the acoustic marker (lead-up
  kept), the END uses speech-end logic, and `armedBy` stays `'acoustic'` (audio was the cause).

A `PERCEPTION_BATCH_MAX_MS` (45 s) hard cap fires either path at the last endpoint if it runs long.
The RMS energy VAD can **only** arm Path B — an RMS blip (a quiet whir) is not speech.

### The three `armedBy` labels in the Studio

The console badge is `armedBy` + `hasSpeech` (whether the enricher found speech *in* the clip):

| `armedBy` | `hasSpeech` | Badge | Meaning |
|---|---|---|---|
| `acoustic` | any | **acoustic event** | Path B — ambient sound opened the window (may still contain speech). |
| `speech` | `true` | **speech endpoint** | Path A happy case — parakeet heard words, enricher confirmed. |
| `speech` | `false` | **VAD endpoint · no speech** | Path A mismatch — parakeet armed the speech path but the enricher found NO speech (a parakeet-vs-enricher disagreement, **not** a VAD event). The label name is legacy; it does not mean the energy VAD fired. |

### Trigger-path gates (console toggles)

> **ADDED 2026-07-13.** Each of the two paths can be turned off independently, live, from the
> Perception Studio's enricher panel (**enrich triggers**: `speech` / `non-speech` checkboxes) →
> `POST /api/perception/enricher {speech?, nonSpeech?}`.

- **speech** gates Path A, **non-speech** gates Path B. The gate is applied at the **arm** point
  (`UtteranceDetector.setEnrichPaths`), so a disabled path never even opens a clip — no Gemini call
  is made for it. Disabling non-speech mid-window also retires an acoustic window already open.
- **Default: speech ON, non-speech OFF.** Only real in-room speech reaches Gemini; ambient/acoustic
  sound is ignored. Rationale: an acoustic window costs a full Gemini call and, in practice, ambient
  sound rarely carries value worth that spend — so it's opt-in, not on by default. (A "VAD endpoint ·
  no speech" row can still appear with only speech on: it's a *speech*-armed clip that came back
  empty, not the non-speech path.)
- State lives in perception's `enricher_` runtime object (`{speech, nonSpeech}`), pushed to every
  live detector via `registerEnrichPathSink`/`applyEnrichPaths`; not a persisted config-registry key.

## Output (one packet, all fields — ONE record kind)

`enrichAudio` returns per-utterance segments; each → one store record. Everything the enricher
emits is **ONE record kind: `'enriched'`** (not split into `speech`/`sound` kinds like the old
path). WHAT it contains — real in-room speech, played media, or a non-speech sound — is the
`audioSource` **field**, so consumers read the field they need (the summarizer treats media/sound
as ambient, speech as conversation; the Studio shows it as an emoji badge; `dropSupersededSpeech`
and `isSalient` gate on `kind==='enriched' && audioSource`). The full packet:
`text · speaker (diarized) · audioSource (speech|media|sound) · audioKind · transcriptConf ·
salience · salienceConf · summary · addressedToRobot/addressConf/directive (when addressed) ·
wokeRobot (stamped by the brain if this utterance actually fired a turn — the row's 🤖 badge)`.
`coalesceSegments` merges over-split fragments into whole utterances, drops in-batch dupes,
collapses repetition loops, and spreads degenerate timestamps (capped at 8 s/segment).
Cross-batch duplicates are dropped in the `onEnrich` handler.

### Addressed → robot latency

When the enricher identifies a segment as addressed-to-orbit, it reaches the brain's wake with
**zero avoidable delay**: `onEnrichAddressed` fires *before* the record is even written, and the
whole chain (`onEnrichAddressed → bgAddressedHandler → brain onAddressed → session.wake()`) is
synchronous — no queue, timer, or debounce. The only latency is the enricher's own upstream batch
(the utterance isn't transcribed until the batch fires), which is the wake-word/mic trade-off, not
the handoff. The brain stamps `wokeRobot` back onto the triggering record right after `wake()`.

## THE MODEL DECISION: flash, not flash-lite

**Default the enricher to `gemini-2.5-flash`, not `gemini-2.5-flash-lite`.**

On real dock-redmi audio (quiet/far-field room with background music, measured RMS 344–872),
**flash-lite hallucinated confident fake conversations from unintelligible audio** — e.g. it
returned *"I'll take the other one."* / a repeating *"Bye… I'm going for a walk… okay…"*
goodbye-loop at 0.9 confidence for windows that contained no clear speech. Verified by
capturing the exact WAVs the enricher received (`PERCEPTION_ENRICH_SAVE=1`):
- audio energy was low (quiet, far-field + music),
- **parakeet transcribing the same WAV returned `''`** (nothing intelligible),
- so the flash-lite text was pure fabrication, unrelated to both the audio and the STT.

**On flash, the enricher is HONEST** about the same audio: *"[unintelligible speech]"*,
*"[Music playing]"*, *"Indistinct speech from a female speaker."* — it stops inventing. The
confidence gate + the "be honest, low transcript_conf if you're guessing" prompt rule only
work with a model that will actually admit uncertainty; flash-lite would not.

Set via `PERCEPTION_ENRICH_MODEL=gemini-2.5-flash` in `.env` (legacy `PERCEPTION_BG_AUDIO_MODEL`
/ `PERCEPTION_BG_STT_MODEL` still seed it) and as the code default in `perception/index.ts`.
Live-switchable from the Studio's 👂 enricher config panel (`/api/perception/enricher`).

### Corollary — separate real issue: the mic

Even flash (and parakeet) can't transcribe faint/far-field speech that isn't clearly there.
The underlying **audio capture is poor** (low RMS, distance, background media) — a mic
gain/placement problem, independent of the enricher. The enricher's honesty + the confidence
pills at least make this *visible* (low voiced%, "[unintelligible]", low transcript_conf)
instead of silently fabricating.

## Guards against garbage in durable memory

- **Hallucination guard** — skip the enrich call entirely when a window is `< 10 %` voiced and
  armed by a speech endpoint (mostly-silence → the model would invent a conversation).
- **Confidence** — the model self-reports `transcript_conf`; low-confidence text is KEPT (not
  hidden) but visibly de-emphasised in the UI and marked `[uncertain]` for the ego.
- **Memory-arm dedup** — parakeet's `liveOnly` records are dropped from summarizer/ego reads
  when an enriched record overlaps the same span (`dropSupersededSpeech`), so the coherent
  enricher transcript wins and nothing double-counts.

## Debuggability

- Each enriched Studio row shows: ⚡ trigger reason · 🔊 voiced % (red < 15 % = mostly silent) ·
  🎙 the raw parakeet STT for the same window (empty = no speech → a hallucination tell) ·
  a color confidence pill + bar · an expandable **⛓ full JSON** (the complete record).
- `PERCEPTION_ENRICH_SAVE=1` dumps the exact 16 kHz WAV the enricher received to
  `.data/enrich-audio/<dock>/<startedAtMs>_v<voiced%>.wav`, self-bounded to
  `PERCEPTION_ENRICH_SAVE_MB` (default **200 MB**, oldest pruned) — so the enricher's text can
  be checked against the real audio during tuning. Left ON while iterating; remove to disable.

## Empirical A/B (capture harness)

The `#capture` console records a dock's audio and reprocesses it with alternate backends for a
side-by-side compare: the enricher (flash / flash-lite) vs Deepgram (diarized) vs Gemini-audio
vs parakeet, all on the *same* recording. Use it to judge which backend transcribes a given mic
best before committing.
