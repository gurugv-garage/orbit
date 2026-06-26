# RCA knowledge base

Root-cause analyses of real bugs we hit and fixed — the **durable record** so a future
debugger (human or agent) can: recognize a recurring symptom fast, reuse the repro, and
not re-walk the wrong turns we already ruled out.

An RCA earns a place here when the bug was **non-obvious** — intermittent, cross-layer, or
where the first (and second) theory was wrong. Trivial one-line fixes don't need one.

## What each RCA must contain

- **Symptom** as the user/operator actually experienced it.
- **Root cause** in one or two sentences, with the evidence that proved it.
- **What it was NOT** — the wrong theories, so we don't repeat them.
- **Repro steps** (stable, with a measured rate where relevant).
- **The fix** (commit refs) + the **validation** that it worked.
- **Instruments** used (logs/endpoints/screenshots) — what to re-enable next time.
- **Method note** — what actually cracked it.

Naming: `YYYY-MM-DD-short-slug.md` (date first → chronological + greppable).

## Index

| Date | RCA | One-line |
|---|---|---|
| 2026-06-26 | [facefollow-iteration-cost](2026-06-26-facefollow-iteration-cost.md) | **Process** post-mortem: why faceFollow took ~8 deploy cycles + 3 controller rewrites — diagnosed on the wrong (intermittent) signal, trusted logs over lived behaviour, sim-green ≠ hardware-works, expensive deploy loop, premature precision. Checklist for the next embodied behaviour. |
| 2026-06-22 | [post-restart-no-stt](2026-06-22-post-restart-no-stt.md) | "UI says listening but no reply" after an app restart — VAD `SILENCE_RMS` gate (0.02) was just above post-restart mic gain (~0.018); lowered to 0.012. Plus listening-glow visibility fixes. |

<!-- newest at the top; add a row per RCA -->

## Lessons that generalize (skim before debugging a perception/conversation issue)

- **For an EMBODIED behaviour, instrument the LAYERS before tuning, and judge on the device,
  not the log.** faceFollow burned ~8 deploy cycles because the fault was an intermittent
  upstream signal (bursty detection / user-not-in-view), not the controller it kept "fixing."
  Layer-attributing telemetry + a user-visible indicator + soak aggregates broke the logjam.
  Full retro: [facefollow-iteration-cost](2026-06-26-facefollow-iteration-cost.md).
- **Instrument, reproduce, validate with screenshots — don't theorize.** Every wrong turn
  this project has taken on conversation bugs came from reasoning ahead of evidence.
- **A thin margin reads as "random."** The post-restart STT bug fired ~50% because mic
  gain sat right on the VAD threshold — look for knife-edge thresholds before assuming a
  hard failure.
- **Silent `catch` blocks hide bugs.** A swallowed opus-decode error sent the
  investigation down a dead end; count/log failures instead of dropping them.
- **Two UI cues from two state sources will disagree.** The countdown (station mode) vs the
  glow (local face state) drifted apart — drive related cues from one authoritative source.
