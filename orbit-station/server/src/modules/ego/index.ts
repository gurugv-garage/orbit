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
import { readFileSync, existsSync } from 'node:fs';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteContext, StationModule } from '../../core/module.js';
import { loadEgo, loadTrace } from './ego-store.js';
import { introspect } from './introspect.js';
import { perceptionSince } from '../perception/index.js';

const LAST_SUMMARY_FILE = '.data/perception/last-summary.json';

/** The introspection CHECKPOINT (§7c): the ego's own `meta.updated` timestamp — "everything
 *  since I last introspected". Falls back to a few hours if absent (fresh dock). Returns an
 *  ISO string in IST (to match the snapshot record timeline). */
function checkpointIso(egoText: string, nowMs: number): string {
  const m = egoText.match(/^-\s*updated:\s*(\S+)/m);
  const ms = m ? Date.parse(m[1]!) : NaN;
  const from = Number.isNaN(ms) ? nowMs - 6 * 3600_000 : ms;
  return new Date(from + 5.5 * 3600_000).toISOString(); // IST-ish, string-comparable to record.interval.from
}

/** Recent CONVERSATION turns for a dock — what was said to/by it since the checkpoint. This
 *  is the recovery signal (a person can only talk the ego down if introspection reads it).
 *  Filters the idle-moods prompt-scaffolding (long coaching/system injections) so the ego
 *  reads real dialogue, not its own machinery. Best-effort. */
function recentConversation(dock: string, sinceIso: string, maxTurns = 30): string {
  try {
    const dir = `.data/brain/${dock}`;
    if (!existsSync(dir)) return '';
    const files = readdirSync(dir).filter((f) => /^s-.*\.json$/.test(f)).sort();
    const turns: string[] = [];
    for (const f of files.slice(-4)) {                       // newest few sessions
      let items: unknown;
      try { items = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (!Array.isArray(items)) continue;
      for (const it of items as Array<{ role?: string; content?: unknown }>) {
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

/** The rolling-summary fallback (used only if the durable raw span is empty — e.g. before the
 *  first persisted records, or on a very long gap). The compression layer, per §7c. */
function summaryFallback(dock: string): string {
  try {
    if (!existsSync(LAST_SUMMARY_FILE)) return '';
    const all = JSON.parse(readFileSync(LAST_SUMMARY_FILE, 'utf8')) as Record<string, { text?: string }>;
    return all[dock]?.text ? `Recent perception (summary):\n${all[dock]!.text}` : '';
  } catch { return ''; }
}

/** "Recent experience" the ego introspects over (§7c): the durable PERCEPTION SPAN since the
 *  ego's own checkpoint (raw, leaned-toward — the enriched truth) + the CONVERSATIONS in that
 *  span (the recovery signal). Falls back to the rolling summary when raw is sparse. */
function recentExperience(dock: string, nowMs: number): string {
  const { text: ego } = loadEgo(dock);
  const since = checkpointIso(ego, nowMs);
  let perception = '';
  try { perception = perceptionSince(dock, since); } catch { /* */ }
  if (!perception) perception = summaryFallback(dock);
  const convo = recentConversation(dock, since);
  const parts: string[] = [];
  if (perception) parts.push(`WHAT YOU SENSED (since you last reflected):\n${perception}`);
  if (convo) parts.push(`A CONVERSATION YOU HAD:\n${convo}`);
  return parts.join('\n\n');
}

/** Run one introspection for a dock, assembling its recent experience — the shared entry
 *  the REST handler and the conductor's idle heartbeat both call. */
export function introspectDock(dock: string, trigger: string) {
  return introspect(dock, recentExperience(dock, Date.now()), { trigger });
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
