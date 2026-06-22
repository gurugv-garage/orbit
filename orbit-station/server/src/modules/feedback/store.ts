/**
 * FeedbackStore — feedback markdown files on disk under `.data/feedback/`
 * (gitignored runtime data, mirrors `.data/brain/`). One MD per feedback, with
 * YAML frontmatter (same convention as Skills / the memory system). No DB.
 *
 * Layout:  .data/feedback/<createdAt>-<dock>-<sessionId>-<short>.md
 * The filename sorts chronologically (ISO timestamp prefix) so a plain dir
 * listing is newest-last; the console reverses it.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeedbackMeta } from './types.js';

/** `.data/feedback/` resolved relative to this source file (decoupled from cwd,
 *  same idiom as core/db.ts). */
const DATA_DIR = fileURLToPath(new URL('../../../.data/feedback/', import.meta.url));

export interface StoredFeedback {
  id: string;
  file: string;
  /** the feedback folder (absolute). */
  dir: string;
  /** the full file path on disk (absolute) — shown in the console so you know
   *  exactly where to open it for analysis. */
  path: string;
  meta: FeedbackMeta;
  content: string;
}

export class FeedbackStore {
  #root: string;

  constructor(root = DATA_DIR) {
    this.#root = root;
  }

  /** The feedback folder on disk (absolute). */
  get root(): string {
    return this.#root;
  }

  /** Write a rendered feedback MD, returning the file id. Atomic (tmp+rename). */
  write(id: string, content: string): string {
    mkdirSync(this.#root, { recursive: true });
    const file = `${safe(id)}.md`;
    const path = join(this.#root, file);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return file;
  }

  /** All feedback items, newest first (parsed frontmatter only — cheap list). */
  list(): FeedbackMeta[] {
    let files: string[];
    try {
      files = readdirSync(this.#root).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        try {
          return parseFrontmatter(f.replace(/\.md$/, ''), readFileSync(join(this.#root, f), 'utf8'));
        } catch {
          return undefined;
        }
      })
      .filter((m): m is FeedbackMeta => !!m)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Full MD content + parsed meta for one feedback, BY its frontmatter id.
   *  Filenames are the human-readable key (timestamp-dock-session-id), so we
   *  resolve the id → file by scanning (the feedback set is small). */
  get(id: string): StoredFeedback | undefined {
    const file = this.#fileFor(id);
    if (!file) return undefined;
    try {
      const content = readFileSync(join(this.#root, file), 'utf8');
      return { id, file, dir: this.#root, path: join(this.#root, file), meta: parseFrontmatter(id, content), content };
    } catch {
      return undefined;
    }
  }

  /** Remove one feedback file (by frontmatter id). */
  delete(id: string): boolean {
    const file = this.#fileFor(id);
    if (!file) return false;
    try {
      rmSync(join(this.#root, file), { force: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve a feedback id → its filename. The filename ENDS with `-<id>.md`
   *  (the key builder appends the id), so match that first; fall back to a
   *  frontmatter scan for any hand-named file. */
  #fileFor(id: string): string | undefined {
    let files: string[];
    try { files = readdirSync(this.#root).filter((f) => f.endsWith('.md')); } catch { return undefined; }
    const safeId = safe(id);
    const direct = files.find((f) => f === `${safeId}.md` || f.endsWith(`-${safeId}.md`));
    if (direct) return direct;
    for (const f of files) {
      try {
        if (parseFrontmatter('', readFileSync(join(this.#root, f), 'utf8')).id === id) return f;
      } catch { /* skip */ }
    }
    return undefined;
  }
}

/** Keep ids filesystem-safe (they're built from dock/session names). */
function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Unwrap a JSON-quoted frontmatter value (yamlInline writes reason/objects as
 *  JSON strings); leave bare values as-is. */
function unquote(v: string): string {
  if (v.startsWith('"')) { try { return JSON.parse(v) as string; } catch { /* fall through */ } }
  return v;
}

/** Pull the YAML frontmatter block into a FeedbackMeta. Tolerant: a malformed
 *  file still lists (with whatever fields parsed) rather than vanishing. */
function parseFrontmatter(id: string, content: string): FeedbackMeta {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  const fields: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
      if (kv) fields[kv[1]!] = unquote(kv[2]!.trim());
    }
  }
  return {
    id: fields.id || id,
    dock: fields.dock || '?',
    sessionId: fields.sessionId || undefined,
    turnId: fields.turnId || undefined,
    createdAt: fields.createdAt || '',
    source: (fields.source as FeedbackMeta['source']) || 'api',
    reason: fields.reason || undefined,
  };
}
