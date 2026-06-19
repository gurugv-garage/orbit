/**
 * The production embedder for memory semantic recall (docs/perception-to-brain.md
 * 4.4) — Gemini's embeddings API (`text-embedding-004`). Chosen for v1 because it
 * reuses the GEMINI_API_KEY already in `.env` (no new sidecar surface) and is cheap
 * for our scale (per-dock, hundreds–low-thousands of memories). Swappable: the
 * MemoryStore takes any `Embedder`; this is just the default wiring.
 *
 * Graceful: returns null on any failure (no key, network, bad response). The store
 * stores the memory anyway — it's just not semantically recallable until re-embedded
 * — and recall falls back to recency. Never throws into the caller.
 */

import type { Embedder } from './store.js';

const MODEL = process.env.MEMORY_EMBED_MODEL ?? 'gemini-embedding-001';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/** The default Gemini embedder. No key → a no-op embedder (always null), so the
 *  memory store still works (structured recall + recency) without semantic search. */
export function geminiEmbedder(): Embedder {
  return async (text: string): Promise<Float32Array | null> => {
    const key = geminiKey();
    if (!key || !text.trim()) return null;
    try {
      const r = await fetch(`${BASE}/${MODEL}:embedContent?key=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: `models/${MODEL}`, content: { parts: [{ text }] } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return null;
      const data = (await r.json()) as { embedding?: { values?: number[] } };
      const values = data?.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) return null;
      return Float32Array.from(values);
    } catch {
      return null;
    }
  };
}
