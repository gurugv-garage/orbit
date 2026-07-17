/**
 * websearch integration — the dock brain's `web_search` tool runs here.
 *
 * Why this exists: the browse skill drives a real headless browser, and every
 * major search engine bot-blocks it (Google serves its /sorry/ "unusual
 * traffic" page, DuckDuckGo a duck-CAPTCHA, Bing an empty shell) — proven live
 * in session s-hum8 (2026-07-16). Scraping engines is an arms race we don't
 * fight; instead "look it up on the web" is answered by Gemini with its
 * built-in google_search grounding: one API call in, a grounded answer with
 * source domains out. The browser remains the right tool for reading a
 * SPECIFIC page — this is the right tool for finding things out.
 *
 * Gate: `webSearchEnabled()` — a Gemini key must be present, the same fail-safe
 * shape as the Slack/WhatsApp tools (never offer a tool that can't run).
 * Spend lands in the Cost tab via reportGeminiCost (label 'web-search').
 */

import { reportGeminiCost } from '../modules/perception/cost-report.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// flash-LITE with thinking OFF: this call is "fetch a fact via search", not
// reasoning — the search grounding does the work (same lesson as the enricher
// cost RCA: flash + default thinking silently 10×'d spend). 3.1-flash-lite, not
// 2.5 (2.5-lite is deprecated for this key), $0.25/$1.50 per M — ~$0.0001/search
// in tokens. The separate grounding fee (Gemini 3.x: 5,000 prompts/month free,
// then $14/1k — ai.google.dev/gemini-api/docs/pricing) is per-REQUEST, so the
// model tier doesn't change it — and it does NOT show in the Cost tab, only in
// Google billing. NOTE: google_search cannot ride on the brain's own turn LLM
// call — Gemini rejects built-in tools + function calling in one request.
const MODEL = process.env.WEB_SEARCH_MODEL ?? 'gemini-3.1-flash-lite';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

export function webSearchEnabled(): boolean {
  return !!geminiKey();
}

/** Ask Gemini (google_search grounding) and return a spoken-answer-ready brief:
 *  the grounded answer plus the source domains it cited. Throws on API failure —
 *  the tool wrapper turns that into a narratable error. */
export async function webSearch(query: string, dockId: string): Promise<string> {
  const key = geminiKey();
  if (!key) throw new Error('no GEMINI_API_KEY');
  const r = await fetch(`${GEMINI_BASE}/${MODEL}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = (await r.json()) as any;
  if (!r.ok) throw new Error(`gemini ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  reportGeminiCost(dockId, MODEL, 'web-search', data?.usageMetadata, Date.now());

  const cand = data?.candidates?.[0];
  const text: string = (cand?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join(' ')
    .trim();
  if (!text) throw new Error('search returned no answer');

  // Grounding chunks carry the cited sources; `title` is the site's domain.
  // Domains (not the long redirect URIs) are what a spoken reply can cite.
  const domains: string[] = [
    ...new Set<string>(
      (cand?.groundingMetadata?.groundingChunks ?? [])
        .map((c: any) => c?.web?.title)
        .filter((t: any): t is string => typeof t === 'string' && t.length > 0),
    ),
  ].slice(0, 5);

  return domains.length ? `${text}\n\nSources: ${domains.join(', ')}` : text;
}
