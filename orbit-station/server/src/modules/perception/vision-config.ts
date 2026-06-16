/**
 * Steerable vision backend + resolution — chosen live from the console so you can
 * A/B moondream (fast, hallucinates) vs md3 (sharp, heavier) and 320 vs 512 px
 * without a restart. Both backends speak Ollama's /api/generate shape (the md3
 * perception-sidecar mimics it), so the processor's client code is identical —
 * only the URL + model change.
 *
 * Shared singleton: the REST endpoint (POST /api/perception/vision-config) writes,
 * the processor reads.
 */

export type VisionModel = 'moondream' | 'md3';

interface Backend { url: string; model: string }

const MOONDREAM: Backend = {
  url: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  model: 'moondream',
};
const MD3: Backend = {
  // the md3 VISION sidecar — a SEPARATE process from STT (port 8079), because two
  // MLX models in one process can crash Metal. Ollama-compatible /api/generate.
  url: process.env.VISION_SIDECAR_URL ?? 'http://127.0.0.1:8079',
  model: 'moondream3',
};

let model: VisionModel = (process.env.VISION_WATCH_MODEL as VisionModel) || 'moondream';

export function visionBackend(): Backend {
  return model === 'md3' ? MD3 : MOONDREAM;
}
export function visionModel(): VisionModel { return model; }

export function setVisionConfig(cfg: { model?: VisionModel }): void {
  if (cfg.model === 'moondream' || cfg.model === 'md3') model = cfg.model;
}

export function getVisionConfig(): { model: VisionModel } {
  return { model };
}
