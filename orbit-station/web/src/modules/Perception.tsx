import { PerceptionStudio } from './PerceptionStudio';

/**
 * Perception panel — the live perception studio is the whole view: per-source
 * streams, STT/diarization, vision, the snapshot timeline, and the collapsible
 * top controls (vision prompt, summarize, diarization, sidecars, known faces).
 * The old per-dock world-state cards were dropped (everything they showed is in
 * the studio's ● Now + timeline, scoped to the selected source).
 */
export function Perception() {
  return (
    <section>
      <PerceptionStudio />
    </section>
  );
}
