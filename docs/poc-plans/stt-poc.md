# STT POC plans — what to try next, and how we'll judge it

> Status: plans only (nothing here is built). Context: the 2026-07-14 wave made the
> speech stack fully local (parakeet live + voice fingerprints; Gemini enricher OFF)
> and surfaced parakeet's own confidence (calibrated tiers; see
> `speech-watch.ts` STT_CONF_*). These POCs are the next levers, in value order.

## How we judge every POC (the ground rules)

- **Measure on OUR audio, not benchmarks.** The utterance dumps
  (`server/.data/utterance-audio/`), the labeled review pages, and the capture
  harness are the test set. Leaderboard WER decides what to *try*, never what to *ship*.
- **Sign-off is user-perceivable** (the voice-stop lesson): a POC passes when the
  improvement is felt at the dock, not when a state-level metric moves.
- **Latency budget thinking:** mouth-stop → turn-start is ~1.5s today, of which
  1300ms is the endpoint silence wait (docs/findings busy-queue Addendum 9). Reply
  latency (turn-start → speech) is a separate budget (~4.3s p50 post-WI-3).
- **Local-first:** cloud engines are benchmark contenders for the async record only;
  the live path stays on-box. Anything shipped should have a story for the
  India-VM move (CPU/ONNX > MLX where possible).
- **Fallback safety:** every new component must degrade to today's behavior when it
  fails (the enricher lesson: additions are tiers, not replacements).
- **One MLX model per process** (Metal crashes) — a new local model = its own
  sidecar process or an ONNX/CPU runtime.

## POC-1 — Semantic end-of-utterance (kill the 1300ms wait) ★ highest value

**Model:** `nvidia/parakeet_realtime_eou_120m-v1` — 120M streaming FastConformer-RNNT
that emits an `<EOU>` token when the speaker is semantically done. EOU latency
p50 160ms / p90 280ms. English-only, WER 9.3% (worse than our 0.6b-v3's 6.3% —
so it ENDPOINTS, it does not replace transcription).

**Design:** it streams the mic continuously; `<EOU>` triggers the utterance commit
(~200–300ms after speech ends) via the `endpointHint()` seam sketched in Addendum 9.
The 1300ms silence timeout stays as fallback (no EOU → today's behavior). 0.6b-v3
still transcribes the committed utterance. Expected win: **~1s off every turn**.

**Spike questions (in order):**
1. Runtime: card is NeMo/CUDA. Can it stream real-time on the Mac (NeMo on CPU?
   torch-MPS?) or via an ONNX export into sherpa-onnx (which runs streaming NeMo
   transducers, and would carry to the VM)? This gates everything.
2. EOU quality on OUR audio: false-endpoint rate on thinking pauses — the exact
   failure that killed STT_ENDPOINT_MS=900 ("My favorite animal." / "Is the red
   panda?" split). Replay the harness timing-edge cases + far-field dumps.
3. Cost: continuous streaming CPU load (always-on, not per-utterance).

**Ship gate:** ≥500ms median improvement mouth-stop→turn-start on live turns, with
no increase in mid-thought splits across the F-series timing cases (merge-supersede
remains the net for rare wrong splits).

## POC-2 — Local escalation tier (fix the shaky band asynchronously)

**Idea (pyramid §9):** utterances with parakeet confidence < STT_CONF_SHAKY (0.85)
get re-transcribed async by a bigger local model; the record is patched in place
(the old enricher's mechanic, minus the cloud). The live path is untouched.

**Candidates:** `whisper-large-v3-turbo` via mlx-whisper (drop-in, zero integration
risk) vs `canary-1b-v2` (beats whisper-large-v3 on WER; different arch, no
parakeet-mlx support — runtime port required, likely not worth it first).

**Spike questions:** how often does the band fire per day (measure from records —
it's on every snapshot now); does whisper-large actually beat parakeet on the
SHAKY-band clips (A/B on the dumps — it may just hallucinate more fluently, the
Gemini lesson); process placement (third sidecar vs reuse of the vision process
slot when idle).

**Ship gate:** blind A/B on ≥30 shaky-band clips: escalated transcript preferred
by ear ≥2:1 over parakeet's. Watch: parakeet is OVERCONFIDENT on short mush
(2s "All right." from noise scored 0.91) — escalation gated on confidence alone
misses that tail; duration+confidence jointly may be the right trigger.

## POC-3 — Media/liveness gate (the open voice-ID false-positive)

**Problem:** voice fingerprinting has no liveness — played media of an enrolled
voice matches (the video-recognized-as-guru incident). The Gemini enricher's
`audioSource: media` tag was the only guard, and it's gone.

**Options to spike (cheapest first):** (a) an audio-scene classifier per utterance
(YAMNet/PANNs-class, tiny, CPU) tagging music/TV/speech-over-speaker;
(b) correlation with the dock's OWN playback state + AEC residual (media playing
on known devices); (c) prompt-side only — the brain already hedges via the
unmatched path; extend hedging when vision sees a screen. Success = the guru-label
false-positive rate on played media drops to ~0 without new latency.

## POC-4 — Cloud escalation benchmarks (record-quality ceiling; bench-only)

Run the capture-harness A/B (recall-reliability methodology) over the same shaky
clips with cloud engines, purely to know how far the local ceiling is from SOTA:

- **Azure LLM Speech** (Foundry `transcriptions:transcribe`, api 2025-10-15):
  LLM-enhanced batch/file STT with diarization + prompt-tuning. Notable limits for
  us: file/batch only (no realtime pivot for the live path), and **`confidence`
  is always 0** — less introspectable than what we now have locally. Cloud + paid
  + privacy-out ⇒ escalation-bench contender only.
- Gemini flash-lite (the old enricher — we have months of its output to compare),
  Deepgram nova (diarization included, conservative on hard audio).

No ship gate — this POC produces a number (local-vs-cloud gap on OUR hard audio)
that decides whether POC-2's local escalation is enough.

## Watch-list (not POCs yet)

- **Streaming interims from the EOU model** — if POC-1 lands, its live tokens could
  replace the interim re-transcribe path (cheaper, faster captions).
- **Hindi/multilingual**: parakeet v3 is European-only; a detected non-English
  utterance could route to whisper (the engine seam already exists).
- **Silero VAD** vs the RMS gate — only if noisy-room false arming becomes a
  measured problem.
- **sherpa-onnx everything** (parakeet int8 + embeddings + diarization + maybe EOU)
  — the VM-portability endgame; revisit when the remote move is scheduled.
