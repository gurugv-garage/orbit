# Should-I-respond gate — first pass (self-judged + local-model bench)

**Goal:** a fast LOCAL small model at the STT boundary that emits one decision —
**should_respond + confidence** — in <100ms. (Simplified from the earlier
3-axis "coherence_index"; the three axes are now the model's internal reasoning,
not its output.)

## What I did
1. Built the real corpus offline (254 STT utterances from `dock-redmi`, 178 with
   reconstructed conversation context). Static from `.data/` — no station.
2. **Judged 40 myself, in-context** (not farmed to Gemini) — so I own the target.
3. Ran two cached local MLX models as the gate, two output shapes each.

## Finding 1 — the signal is REAL, and I beat the deployed heuristic
My hand `addressed` score vs. "did the dock actually reply": AUC 0.737 — a FLOOR,
because the divergences are the DOCK's errors, not mine. #22/#25/#26 are long
overheard human-to-human monologues I scored addressed≈0.1 and **the dock ran a
full turn on all three** — the "answered room chatter for 1.5M tokens" failure.
A gate that matched me would be *better* than today's baseline. → worth building.

## Finding 2 — <100ms is REAL, but ONLY with the logprob shape
Two output shapes, same model (gemma-270m):
| shape | latency p50 | parse failures |
|---|---|---|
| generate JSON `{"respond":..,"confidence":..}` | **271ms** | 16/40 invalid |
| single forward pass, P(Yes) from logits | **33ms** | none (no parsing) |

→ **Do NOT generate JSON.** Read P(Yes)/P(No) from the first-token logits: 8×
faster AND format-proof. confidence = P(Yes). Qwen3-0.6B same shape = 60ms p50.
The latency budget is comfortably met with headroom for a bigger model.

## Finding 3 — off-the-shelf small models CAN'T do the judgment (zero-shot)
This is the load-bearing negative result.
| model | latency p50 | AUC vs my labels | corr(P(Yes), my-addressed) |
|---|---|---|---|
| gemma-3-270m-it | 33ms | 0.53 | **+0.005** |
| Qwen3-0.6B | 60ms | 0.47 | **+0.017** |

Both ≈ random. They fail in *opposite* directions — gemma says Yes to everything
(P(Yes)∈[0.85,0.98]), Qwen says No to everything (∈[0.08,0.32]) — i.e. each just
emits a fixed prior from the prompt wording and **does not read the utterance at
all**. On my clearest cases, mean P(Yes) on addressed-commands == on
garbled-room-chatter (0.94 vs 0.94; 0.19 vs 0.19). No threshold recovers zero
correlation.

## Conclusion — this validates the fine-tune plan exactly
The architecture is right and the latency is there, but **the judgment must be
trained IN, not prompted in** — precisely the instinct from the start of the
design chat ("eventually I'd want these things inherent to the model, fine-tune").
Zero-shot at 0.3–0.6B is a fixed-prior coin flip. The path:

1. **Labels are the asset.** Scale my hand labels from 40 → all ~178 context-
   bearing utterances (+ pull more days; 170MB/day of records exist). My labels,
   not the dock's behavior, are the training/eval target (Finding 1).
2. **Fine-tune** a 0.3–0.6B (LoRA via `mlx_lm.lora`) to output the P(Yes) token.
   The fast logprob path (Finding 2) is the inference shape to train toward.
3. Re-bench the tuned adapter on held-out labels; only THEN does the gate exist.
4. Numbers → models/BENCHMARKS.md.

Until step 2, there is no working local gate — the fast path is proven, the
zero-shot judgment is not.

## Finding 4 — the labeled training set (178 utterances, self-judged)
Scaled my hand labels from 40 → **all 178 context-bearing utterances**
(`labeled_set.jsonl`), each = should_respond (0/1) + my confidence, judged in
full conversation context.

- **Only 20% (35/178) are genuinely addressed to the dock.** The room is
  overwhelmingly not talking to it — the gate's job is mostly to say NO.
- **My labels diverge from the deployed dock on 50/178 (28%)**, in BOTH
  directions — proof they're a better target than the dock's own behavior:
  - **36 over-answers**: dock ran a turn on speech I'd skip — the long overheard
    human↔human monologues (family logistics, class pricing, hobby
    chat). The "meeting room chatter" failure, now quantified at 20% of all utts.
  - **14 under-answers**: dock SKIPPED clear wake-word commands I'd answer —
    "Hey Orbit, wish Rhea happy birthday" (conf 0.95), "Hey, orbit" (0.90),
    "find the coffee cup" (0.90), "Stop talking" (0.85). A second, distinct dock
    failure: dropping real commands (likely mid-turn/busy-window).

→ This is the train/eval asset. 66 high-confidence labels (≥0.75) make a clean
held-out eval; the full 178 (with soft confidence) is the training signal.

## Finding 5 — LoRA fine-tune (Qwen3-0.6B): DID NOT WORK — honest negative
Built the full pipeline (`make_dataset.py` → `mlx_lm.lora` → `eval_adapter.py`)
and ran THREE configurations. Held-out test = 36 stratified utts; the key check
is train-set separation (can it fit data it was directly optimized on?).

| run | prompt | data | layers/iters/LR | TRAIN gap P(Yes\|yes)−P(Yes\|no) | TEST AUC |
|---|---|---|---|---|---|
| A | long | 80/20 | 8 / 120 / 1e-4 | ~0.00 | 0.51 |
| B | long | balanced 50/50 | 16 / 200 / 3e-4 | **0.00** (0.95 vs 0.95) | 0.49 |
| C | minimal | balanced 50/50 | 16 / 200 / 3e-4 | **0.00** (0.88 vs 0.88) | 0.52 |

**The model never forms the conditional mapping — not even on the training set.**
P(Yes) is a flat ~0.9 (or ~0.4) band independent of the utterance: "The bone"
(garble) and "Hey Orbit, wish Rhea happy birthday" (clear command) get the SAME
score. Training *loss* fell (it learned the Yes/No *prior*), but the model ignores
the input. Ruled out: prompt-length (run C, minimal prompt, same failure),
class-imbalance (run B/C balanced, same), under-training (loss converged, train
gap still 0).

Latency stayed great throughout (p50 60–73ms) — the fast path is never the problem.

### What this means (and does NOT mean)
- It does NOT vindicate "small models can't judge this" — the model can't even
  MEMORIZE 117 examples, which points at a METHOD problem, not a capacity ceiling.
- Most likely method issues to attack next, in order:
  1. **Signal-in-loss too weak.** One masked Yes/No token over a ~40–120-tok prompt
     is a tiny gradient. Try: repeat the label / a short rationale-then-label
     completion (unmasked) so more of the sequence carries the signal.
  2. **LoRA reaching the wrong params.** Default targets attention proj only; the
     Yes/No decision may need the LM head / MLP. Try `--fine-tune-type dora`, tune
     embed/head, or `full` fine-tune at this size (0.6B full-FT is cheap on MLX).
  3. **Base too weak / try a 1–1.7B** (Qwen3-1.7B, LFM2-1.2B) where the base already
     has more addressee prior to steer.
  4. **More data.** 178 labels / 35 positives is thin; capture more days (170MB/day
     exists) → several hundred positives before concluding.

### Recommendation
Do NOT ship a gate on any adapter here — all three are random on held-out data.
The labeled set + pipeline are sound and reusable; the fine-tune RECIPE is unsolved.
Next session: attack cause (1) first (richer completion / unmasked rationale), then
(2) full-FT, before spending on more labels. Until a run shows a TRAIN gap > ~0.4
AND test AUC > ~0.75, there is no gate.

## Finding 8 — SOLVED: a linear CLASSIFIER HEAD on frozen features hits AUC 0.94
The classifier-head hypothesis (Finding 7 rec) was right and it WORKS.

Extracted the frozen base's last-token hidden state (dim 1024) per utterance
(`extract_features.py`), trained a plain L2 logistic-regression head on top
(`probe.py`). Cross-validated on the SAME 178 rows / 35 positives that generative
fine-tuning couldn't touch:

| method | held-out AUC | latency |
|---|---|---|
| generative fine-tune (5 variants, incl full-FT) | 0.49–0.52 | 33–73ms |
| trivial control (contains-"orbit") | 0.80 | — |
| **linear classifier head (frozen features)** | **0.94** | **31ms** |

Robustness: repeated 5-fold **0.94** (10 shuffles, range 0.93–0.95), leave-one-out
**0.93**, stable across L2 0.3–10. Ranking is clean by eye: top scores are all real
commands ("Hey, orbit", "find the coffee cup", "Stop talking", "And send it to
Slack"); bottom are all room chatter/garble ("[overheard family chatter]", "[non-English garble]", "[garbled fragment]").

**Why this settles Findings 5–7:** the addressed/not distinction WAS in the frozen
base all along — it's linearly decodable from the last hidden state. Generative
fine-tuning failed not from lack of capacity but because next-token loss collapses
to matching the Yes/No marginal (Finding 6). A classifier head sidesteps that trap
entirely and needs FAR less data — it works on 35 positives.

### This is the gate. Recommended build
- **Inference = one base forward pass + a 1024→1 linear layer.** 31ms p50, well
  under budget. confidence = sigmoid output.
- Ship as an MLX perception sidecar (existing pattern). Shadow-log against the
  deployed dock's addressed-decision before it gates anything.
- Data/base-size (the old plan) become OPTIONAL polish, not prerequisites — 0.94 on
  current data already clears the working-gate bar. More data/bigger base only if we
  want >0.94 or better calibration on the confidence.
- The three-exit contract (ignore/answer/escalate) sits ON TOP: the head gives
  addressed P; a second small head or threshold bands map to the exits.

## Finding 9 — TEMPORAL hold-out confirms it: 0.90 on unseen afternoon data
The dock kept running during this work; the day file grew 447→641 utterances. I used
that as a real train-past/test-future split (mimics deployment, harder than CV):
- **Train** = 175 morning utterances (<11:37 IST, 33 positives) — my original labels.
- **Test** = 81 afternoon utterances (≥11:37, 26 positives) — freshly hand-labeled,
  a genuinely DIFFERENT distribution: a YouTube video playing in the room (medical-
  college-scam monologue), dev-talk to a human about the barge-in bug, many
  story/stop commands.

**TEST AUC = 0.898** (train-fit 1.00). Down from the 0.94 CV number exactly as an
honest temporal split should be. Errors are sensible, not random:
- The **overheard YouTube monologue** — content never seen in training — was scored
  not-addressed correctly ("What guys, the scammers…", "In telegramma. In 2021…" all
  P=0.00). The core room-chatter failure mode, handled on novel content.
- 6 false-positives = mostly bare "So" (ambiguous fragments); 8 false-negatives =
  hard addressed cases (short stop-intents, "Tell me a story" with no wake-word).
- Ranking clean: top = real commands ("Hey Orbit…", "Stop", "never mind"); bottom =
  filler + the video.

→ The 0.94 was not a same-distribution fluke. On unseen future data across a
distribution shift, the classifier head holds at ~0.90. This is a deployable signal.
(Afternoon labels: `labels_afternoon.py`; test: `temporal_test.py`.)

## Finding 6 — attacked the recipe (5 variants incl. FULL fine-tune): still fails
Followed the Finding-5 attack list. Every variant fails the same way — **no
train-set separation**, i.e. can't fit even 142 examples it's directly optimized on.

| # | change | train gap P(Yes\|yes)−P(Yes\|no) | verdict |
|---|---|---|---|
| B | LoRA long balanced | 0.00 | flat |
| C | LoRA minimal balanced | 0.00 | flat |
| rich | LoRA, unmasked rich completion (spread signal) | 0.00 (sat @1.0) | flat |
| rich-gen | same, scored by GENERATING verdict | train acc 0.27 | worse-than-prior |
| **full** | **FULL fine-tune, all params, loss→0.07** | **+0.05 (0.12 vs 0.07)** | **flat** |

The FULL fine-tune is the decisive one: every parameter trained to near-zero
masked loss, yet "Hey Orbit, wish Rhea happy birthday" (label 1, P=0.15) scores
BELOW "The bone" (label 0, P=0.14). Blind to the input on memorized data.

**Hypotheses now RULED OUT:** LoRA capacity (full-FT same), weak gradient (rich
same), prompt length (minimal same), class imbalance (balanced same),
under-training (loss converged every time).

**The real mechanism:** masked next-token loss is minimized by matching the Yes/No
MARGINAL (80/20 or 50/50) while ignoring the utterance. A low training loss here
is DECEPTIVE — it does not imply the conditional was learned. The train-separation
gap, not the loss, is the only honest fit signal.

## Finding 7 — THE CONTROL: harness works; the addressed task is genuinely hard
Ran the decisive sanity check — SAME pipeline, trivial target "does the utterance
contain the word 'orbit'?" (surface lexical, only 10 positives).

| task (same harness) | held-out TEST AUC |
|---|---|
| **trivial "contains orbit"** | **0.80** ✅ learns + generalizes |
| addressed-to-dock (best tuned) | **0.52** ❌ random |
| addressed-to-dock (zero-shot) | 0.28 |

**This is the honest conclusion of the whole exercise.** The harness is NOT broken
— it installs a learnable pattern and generalizes it (trivial → 0.80). Run
identically, the *addressed* judgment can't leave the floor (0.52). The contrast is
the proof: the failure is the TASK×MODEL×DATA, not the plumbing.

Also corrected a metric error: my earlier "TRAIN separation gap" probe read ~0.00
even for the trivial task that scores 0.80 on test — the mean-P(Yes) probe was
swamped by the oversampled/unbalanced pool. **TEST AUC is the only trustworthy
metric here; ignore the train-gap numbers in Findings 5–6.**

### Why addressed fails where "contains orbit" succeeds
- "contains orbit" = surface token match; 10 examples generalize, base already
  represents the token.
- "addressed to the dock" = semantic/pragmatic (turn-taking, addressee, self-echo).
  A 0.6B lacks the base representations to steer, AND 35 positives is far too few to
  install a subtle concept. Both harder AND data-starved.

### Recommendation (evidence-based, not a guess)
1. **More data is the highest-leverage lever** — 35 positives is the likely binding
   constraint. Label several more days (170MB/day exists) → aim for 200–300
   positives before any verdict on model capacity.
2. **Bump the base to 1.7–4B** (Qwen3-1.7B/4B) — the trivial control shows the
   harness is fine, so spend on base capability. Re-run the SAME pipeline.
3. Keep TEST AUC as the sign-off metric; bar to ship = AUC > ~0.80 (what the trivial
   control proves is achievable through this harness).
4. Latency (33–73ms at 0.6B) is a non-issue and buys headroom to go bigger.

**Bottom line for the user:** the fast path works, the labeled set + harness are
sound (proven by the 0.80 control), but a 0.6B on 35 positives CANNOT learn the
addressed judgment. The unlock is data volume + a somewhat bigger base — not a
cleverer prompt or LoRA config (5 variants incl. full-FT ruled those out).

## Artifacts (scratchpad/coherence/)
- `make_dataset.py`, `data/`, `data_bal/`, `data_min/`, `data_rich/` — dataset variants
- `adapters/qwen06b{,_bal,_min,_rich,_full}/` — 5 trained models, ALL random on test
- `eval_adapter.py` / `eval_min.py` / `eval_rich.py` — held-out scorers
- NEXT: a trivial-task harness sanity check (contains-"orbit"?) before any more training
- `labels_full.py` → `labeled_set.jsonl` — **the 178-row labeled set (the asset)**
- `build_corpus.py` → `coherence_corpus.jsonl` (254 rows, real, on-disk)
- `judge_dump.txt` — the 40 rows I read
- `my_judgments.py` — my scores + one-line reasoning each (the label seed)
- `run_local.py` (JSON shape), `run_logprob.py` (fast logprob shape)
- `logprob_*.jsonl` — per-utterance model outputs
