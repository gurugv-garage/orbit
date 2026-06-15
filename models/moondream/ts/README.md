# ts — TypeScript client + structure extraction

The production-path port of the moondream client: the Ollama call, the
structure-extraction strategies, and `polarity()` (the NL→boolean parser the
orbit-station perception processor reuses to derive structure from md2's open
answers — see [../FINDINGS.md](../FINDINGS.md)).

> **Reference copy.** These were developed under `orbit-station/server` (where
> `zod`, `tsx`, and the tsconfig live). Here they're checked in alongside the
> rest of the moondream work for reference; to *run* them, the real home is the
> station's perception module, which imports them with the station's deps. They
> won't `tsx`-run standalone from this folder (no `zod`/tsconfig).

- `moondream.ts` — `captureFrame` (ffmpeg 320×240), `generate` (Ollama), and the
  `ask`/`askYesNo`/`askJson`/`askFields` strategies + `polarity()`.
- `structure-probe.ts` — scores each strategy on live frames.
- `profile.ts` — latency/RSS profiler.
