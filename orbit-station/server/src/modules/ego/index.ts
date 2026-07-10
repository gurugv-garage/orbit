/**
 * Ego module — the per-dock ego document (docs/decision-traces/ego.md), its introspection,
 * and its trace. Slice 1: manual trigger + read surface (console Ego tab). The conductor
 * idle auto-trigger is slice 2.
 *
 * REST (/api/ego):
 *   GET  /:dock              → { dock, ego, exists }           the current ego document
 *   GET  /:dock/trace        → { dock, entries:[{name,ts}] }   past introspections (newest first)
 *   GET  /:dock/trace/:name  → { name, ego }                   one past ego snapshot
 *   POST /:dock/introspect   → { ok, fresh, snapshotted, trigger }  run one introspection now
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteContext, StationModule } from '../../core/module.js';
import { loadEgo, loadTrace } from './ego-store.js';
import { introspect } from './introspect.js';
import { reconciledPerceptionSince } from '../perception/index.js';

const LAST_SUMMARY_FILE = '.data/perception/last-summary.json';

/** The introspection CHECKPOINT (§7c): the ego's own `meta.updated` timestamp — "everything
 *  since I last introspected". Falls back to a few hours if absent (fresh dock). Returns an
 *  ISO string in IST (to match the snapshot record timeline). */
function checkpointMs(egoText: string, nowMs: number): number {
  const m = egoText.match(/^-\s*updated:\s*(\S+)/m);
  const ms = m ? Date.parse(m[1]!) : NaN;
  return Number.isNaN(ms) ? nowMs - 6 * 3600_000 : ms;
}
/** The checkpoint as an IST-ish ISO string, string-comparable to record.interval.from. */
function checkpointIso(egoText: string, nowMs: number): string {
  return new Date(checkpointMs(egoText, nowMs) + 5.5 * 3600_000).toISOString();
}

/** Recent CONVERSATION turns for a dock — what was said to/by it SINCE THE CHECKPOINT. This is
 *  the recovery signal (a person can only talk the ego down if introspection reads it), and it
 *  must be *scoped to the span since the last reflection* — reflecting over months of stale
 *  sessions makes the self ruminate on whatever dominated the archive, not on its actual recent
 *  life. Session items carry an epoch-ms `timestamp`; we keep only those at/after `sinceMs`.
 *  Filters the idle-moods prompt-scaffolding (long coaching/system injections) so the ego reads
 *  real dialogue, not its own machinery. Best-effort. */
function recentConversation(dock: string, sinceMs: number, maxTurns = 40): string {
  try {
    const dir = `.data/brain/${dock}`;
    if (!existsSync(dir)) return '';
    // by mtime: only sessions touched at/after the checkpoint can hold in-span turns (with a
    // small slack, since mtime is the last write). Cheap pre-filter before reading contents.
    const files = readdirSync(dir)
      .filter((f) => /^s-.*\.json$/.test(f))
      .map((f) => ({ f, m: (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })() }))
      .filter((x) => x.m >= sinceMs - 60_000)
      .sort((a, b) => a.m - b.m)
      .map((x) => x.f);
    const turns: string[] = [];
    for (const f of files) {
      let items: unknown;
      try { items = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (!Array.isArray(items)) continue;
      for (const it of items as Array<{ role?: string; content?: unknown; timestamp?: number }>) {
        // scope to the span since the last introspection (drop older archived turns)
        if (typeof it.timestamp === 'number' && it.timestamp < sinceMs) continue;
        const role = it.role;
        let text = typeof it.content === 'string' ? it.content
          : Array.isArray(it.content) ? (it.content as Array<{ text?: string }>).map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ')
          : '';
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // drop prompt-scaffolding: long user-role coaching/system injections + bracketed directives
        if (role === 'user' && (text.length > 220 || text.startsWith('['))) {
          if (!/\b(failed|finished|update|came into view|wake)\b/i.test(text.slice(0, 80))) continue;
          text = text.slice(0, 140);
        }
        const who = role === 'user' ? 'person' : role === 'assistant' ? 'me' : role ?? '?';
        if (who === 'me' || who === 'person') turns.push(`${who}: ${text}`);
      }
    }
    return turns.slice(-maxTurns).join('\n');
  } catch {
    return '';
  }
}

/** The rolling summary + its window end, read from disk (the summarizer's reconciled "now"). */
function rollingSummary(dock: string): { text: string; toIso?: string } | undefined {
  try {
    if (!existsSync(LAST_SUMMARY_FILE)) return undefined;
    const all = JSON.parse(readFileSync(LAST_SUMMARY_FILE, 'utf8')) as Record<string, { text?: string; window?: { to?: string } }>;
    const r = all[dock];
    return r?.text ? { text: r.text, toIso: r.window?.to } : undefined;
  } catch { return undefined; }
}

/** "Recent experience" the ego introspects over. The perception it reads is the summarizer's
 *  RECONCILED output — NOT raw sensor lines (raw contradictions like IDENTITY "no one" beside a
 *  hallucinated vision line make a faithful self conclude "my eyes are broken"; the summarizer is
 *  the one place noise is quality-controlled — user decision 2026-07-10). Plus the CONVERSATIONS
 *  in the span (speech actually addressed to the dock — the recovery signal). Async: reconciling
 *  the fresh tail is a Gemini call (cheap at ≤hourly introspection). */
async function recentExperience(dock: string, nowMs: number): Promise<string> {
  const { text: ego } = loadEgo(dock);
  const since = checkpointIso(ego, nowMs);
  const sinceMs = checkpointMs(ego, nowMs);
  let perception = '';
  try { perception = await reconciledPerceptionSince(dock, since, rollingSummary(dock)); } catch { /* */ }
  const convo = recentConversation(dock, sinceMs);
  const parts: string[] = [];
  if (perception) parts.push(`WHAT YOU SENSED (your reconciled read — senses are noisy, so this is the quality-controlled picture, not raw sensor lines):\n${perception}`);
  if (convo) parts.push(`A CONVERSATION YOU HAD (speech actually addressed to you):\n${convo}`);
  return parts.join('\n\n');
}

/** Run one introspection for a dock, assembling its recent experience — the shared entry
 *  the REST handler and the conductor's idle heartbeat both call. */
export async function introspectDock(dock: string, trigger: string) {
  return introspect(dock, await recentExperience(dock, Date.now()), { trigger });
}

/** The dock's current ego document (or undefined if it's still the bare template — nothing
 *  worth injecting yet). The brain reads this each turn as WHO IS SPEAKING (ego.md §3.5). */
export function getSelf(dock: string): string | undefined {
  const { text, fresh } = loadEgo(dock);
  return fresh ? undefined : text; // don't inject the un-introspected template as "who you are"
}

export function egoModule(): StationModule {
  return {
    name: 'ego',
    topic: 'ego',
    description: 'per-dock ego document (identity + story), introspection, and its trace',
    init(_bus: Bus) { /* slice 1 is REST-only; the conductor auto-trigger lands in slice 2 */ },
    async route(ctx: RouteContext): Promise<boolean> {
      const { req, res, subPath } = ctx;

      // GET /:dock/trace/:name — one past ego snapshot
      let m = subPath.match(/^\/([^/]+)\/trace\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const [, dock, name] = m;
        const entry = loadTrace(dock!, 500).find((e) => e.name === name);
        json(res, entry ? 200 : 404, entry ? { name, ego: entry.text } : { error: 'no such snapshot' });
        return true;
      }

      // GET /:dock/trace — the list of past introspections (newest first)
      m = subPath.match(/^\/([^/]+)\/trace$/);
      if (m && req.method === 'GET') {
        const [, dock] = m;
        const entries = loadTrace(dock!, 200).reverse().map((e) => ({ name: e.name, ts: e.name }));
        json(res, 200, { dock, entries });
        return true;
      }

      // POST /:dock/introspect — run one introspection now (manual trigger)
      m = subPath.match(/^\/([^/]+)\/introspect$/);
      if (m && req.method === 'POST') {
        const [, dock] = m;
        try {
          const r = await introspectDock(dock!, 'manual');
          json(res, 200, { ok: true, dock, fresh: r.fresh, snapshotted: r.snapshotted, trigger: r.trigger, ego: r.ego });
        } catch (e) {
          json(res, 500, { ok: false, error: String((e as Error).message || e) });
        }
        return true;
      }

      // GET /:dock — the current ego
      m = subPath.match(/^\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const [, dock] = m;
        const { text, fresh } = loadEgo(dock!);
        json(res, 200, { dock, ego: text, exists: !fresh });
        return true;
      }

      return false;
    },
  };
}
