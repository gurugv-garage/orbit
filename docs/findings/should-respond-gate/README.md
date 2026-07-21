# should-respond gate — investigation (2026-07-21)

A fast **local** classifier at the STT boundary that judges *"should the dock
respond to this utterance?"* (should_respond + confidence, <100ms), to stop the
dock answering overheard room chatter. Built and validated in one session.

## Read these first
- **[EXPLAINER.md](EXPLAINER.md)** — plain-language walkthrough (no ML background
  needed): what the problem is, the two approaches tried, why the intuitive one
  failed and the classifier-head one worked, and a **reading list** of the concepts.
  Start here.
- **[FINDINGS.md](FINDINGS.md)** — the full technical record: all 9 findings, the
  five failed fine-tune variants, the trivial control, the classifier-head result,
  and the temporal hold-out. The numbers and the reasoning.

## Result in one line
Teaching a 0.6B model to *say* Yes/No fails (AUC ~0.5 — it learns to always say the
common answer). Reading the model's own internal understanding with a tiny linear
**classifier head** works: **CV AUC 0.94**, **0.90 on a temporal hold-out** (train
morning / test unseen afternoon), **31ms**. The model already knew; it just couldn't
say it via next-token generation.

## Artifacts (the reusable asset)
- `labeled_set.jsonl` — 178 real dock utterances, each with conversation context +
  my should_respond label. THE training/eval asset. (+ 81 afternoon labels in
  `labels_afternoon.py`.)
- `labels_full.py` / `labels_afternoon.py` — the hand labels + rubric + per-row notes.
- `build_corpus.py` — reconstructs (utterance → context) pairs from
  `orbit-station/server/.data/{perception,brain}` on disk.
- `extract_features.py` — frozen-base hidden-state features (the embeddings).
- `probe.py` — trains + cross-validates the linear classifier head.
- `temporal_test.py` — train-morning / test-afternoon generalization check.

## Note on paths
These scripts were written against a session scratchpad and read a
`coherence_corpus.jsonl` built by `build_corpus.py`. To re-run: point
`build_corpus.py` at the current `.data/` (it takes a dock name), then run
`extract_features.py` → `probe.py`. Requires the MLX python at
`~/.pyenv/versions/3.13.1/bin/python` (has `mlx_lm`); plain `python3` won't work.

## Status
Signal validated, **not yet wired**. Next step (not started): ship as an MLX
perception sidecar with live shadow-logging against the deployed addressed-decision
before it gates anything. See the memory note `should-respond-gate` for the full
decision trail.
