/**
 * SessionStore — persistence + lifecycle for dock brain sessions
 * (docs/decision-traces/server-brain-impl.md §3.0).
 *
 * A SESSION is a bounded conversational engagement of a dock: opened lazily
 * on the first turn, closed on idle timeout or explicit end, decoupled from
 * connections and processes (history survives app restarts AND station
 * restarts inside the idle window).
 *
 * Layout under `.data/brain/<dock>/`:
 *   sessions.json            index: [{ sessionId, openedAt, lastTurnEndedAt, closedAt?, turns, summary? }]
 *   <sessionId>.json         the open/closed transcript (AgentMessage[]), rewritten
 *                            atomically at each turn end — transcripts are capped
 *                            (~48 messages), whole-file write is simpler and
 *                            crash-safe (tmp + rename) than appending.
 *
 * (The plan allowed pi's harness JSONL repo; it is built around the coding
 * agent's entry/branching model — more machinery than a capped dock
 * transcript needs. This stays swappable behind the same surface.)
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { dataPath } from '../../core/data-dir.js';

export interface SessionMeta {
  sessionId: string;
  openedAt: number;
  lastTurnEndedAt: number;
  closedAt?: number;
  /** why it closed ('idle' | 'console' | 'switched' | …). 'console' = a human
   *  explicitly ended it — presence must NOT resume it (WI-5,
   *  busy-queue-black-hole.md: `session/end` was undone ~2s later by the
   *  presence path, so a fresh session was impossible while the phone was
   *  connected). Absent on records from before this field: treated as
   *  resumable (the old behavior). */
  closedBy?: string;
  turns: number;
  /** short text summary written at close (compaction hook — phase 2 seeds
   *  the next session with it). */
  summary?: string;
}

export class SessionStore {
  #root: string;

  constructor(root = dataPath('brain')) {
    this.#root = root;
  }

  /** The data root (`.data/brain`) — skills.ts resolves per-dock skill dirs
   *  under the same tree. */
  get root(): string {
    return this.#root;
  }

  /** The open (not yet closed) session for a dock, if any. (Background TASKS are
   *  NOT sessions — they are separate processes the TaskSupervisor tracks; the
   *  store only holds the dock's one conversational session.) */
  openSession(dock: string): SessionMeta | undefined {
    return this.#index(dock).find((s) => s.closedAt == null);
  }

  /** Open a fresh conversational session (caller ensures none is open). */
  open(dock: string): SessionMeta {
    const idx = this.#index(dock);
    const meta: SessionMeta = {
      sessionId: this.#newSessionId(idx),
      openedAt: Date.now(),
      lastTurnEndedAt: Date.now(),
      turns: 0,
    };
    idx.push(meta);
    this.#writeIndex(dock, idx);
    return meta;
  }

  /** A short, easy-to-read session id: `s-` + 4 alphanumeric chars (no `sess-`
   *  uuid). Short enough to remember/type for debugging; collision-checked against
   *  this dock's existing sessions (36^4 ≈ 1.7M space — retries are vanishingly
   *  rare). */
  #newSessionId(existing: SessionMeta[]): string {
    const taken = new Set(existing.map((s) => s.sessionId));
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const mint = () => `s-${Array.from({ length: 4 }, () => ALPHABET[(Math.random() * 36) | 0]).join('')}`;
    let id = mint();
    while (taken.has(id)) id = mint();
    return id;
  }

  /** Load the transcript of a session ([] when none persisted). */
  messages(dock: string, sessionId: string): AgentMessage[] {
    try {
      return JSON.parse(readFileSync(this.#file(dock, `${sessionId}.json`), 'utf8')) as AgentMessage[];
    } catch {
      return [];
    }
  }

  /** Persist the transcript + bump turn counters (called at each turn end). */
  turnEnded(dock: string, sessionId: string, messages: AgentMessage[]): void {
    this.#writeJson(this.#file(dock, `${sessionId}.json`), messages);
    const idx = this.#index(dock);
    const meta = idx.find((s) => s.sessionId === sessionId);
    if (meta) {
      meta.turns += 1;
      meta.lastTurnEndedAt = Date.now();
      this.#writeIndex(dock, idx);
    }
  }

  /** Close a session with a summary (idle timeout / explicit end / reset). The
   *  task cascade (stopping a closed session's background tasks) is the
   *  TaskSupervisor's job — see DockBrainSession.endSession. */
  close(dock: string, sessionId: string, summary: string, closedBy?: string): void {
    const idx = this.#index(dock);
    const meta = idx.find((s) => s.sessionId === sessionId);
    if (!meta || meta.closedAt != null) return;
    meta.closedAt = Date.now();
    if (closedBy) meta.closedBy = closedBy;
    meta.summary = summary;
    this.#writeIndex(dock, idx);
  }

  /** All sessions of a dock, newest first (console). */
  sessions(dock: string): SessionMeta[] {
    return [...this.#index(dock)].sort((a, b) => b.openedAt - a.openedAt);
  }

  /** Export a session as a pi-harness-compatible v3 session JSONL string, so it
   *  can be opened directly with `pi --session <file>` or any pi-based tool
   *  (SessionManager.open). We store only the `AgentMessage[]` — which is exactly
   *  the payload of a `message` entry — so the dump wraps each message in the
   *  entry envelope pi expects and prepends the version-3 `session` header.
   *
   *  The tree is a linear chain: each message's parentId = the previous entry's
   *  id (root's is null). pi computes the active leaf as the last entry's id, so
   *  a linear dump needs no trailing `leaf` marker. Entry ids are the first 8 hex
   *  of a fresh UUIDv7 (matching pi's `generateEntryId`); `cwd` is best-effort
   *  process.cwd() (metadata only — pi doesn't require it to match to open). */
  dumpJsonl(dock: string, sessionId: string): string {
    const messages = this.messages(dock, sessionId);
    const iso = () => new Date().toISOString();
    const lines: string[] = [
      JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), timestamp: iso(), cwd: process.cwd() }),
    ];
    let parentId: string | null = null;
    for (const message of messages) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      lines.push(JSON.stringify({ type: 'message', id, parentId, timestamp: iso(), message }));
      parentId = id;
    }
    return lines.join('\n') + '\n';
  }

  /** Upgrade a session's summary after the fact (the async LLM compaction
   *  lands after close() already wrote the cheap tail digest). */
  setSummary(dock: string, sessionId: string, summary: string): void {
    const idx = this.#index(dock);
    const meta = idx.find((s) => s.sessionId === sessionId);
    if (!meta) return;
    meta.summary = summary;
    this.#writeIndex(dock, idx);
  }

  /** Delete a session permanently: drop it from the index and remove its
   *  transcript file. Refuses the currently-OPEN session (close/end it first) —
   *  returns 'open' so the caller can surface that; 'gone' if it never existed;
   *  'deleted' on success. */
  delete(dock: string, sessionId: string): 'deleted' | 'open' | 'gone' {
    const idx = this.#index(dock);
    const meta = idx.find((s) => s.sessionId === sessionId);
    if (!meta) return 'gone';
    if (meta.closedAt == null) return 'open'; // never delete a live session out from under a turn
    this.#writeIndex(dock, idx.filter((s) => s.sessionId !== sessionId));
    try { rmSync(this.#file(dock, `${sessionId}.json`), { force: true }); } catch { /* already gone */ }
    return 'deleted';
  }

  /** Re-open a closed session (console "continue"). The caller must have
   *  closed any currently-open session first — one open session per dock.
   *  The transcript is still on disk; the next turn resumes mid-conversation.
   *  `lastTurnEndedAt` bumps to now so the idle clock restarts. */
  reopen(dock: string, sessionId: string): boolean {
    const idx = this.#index(dock);
    // one open session per dock — refuse if one is already open.
    if (idx.some((s) => s.closedAt == null)) return false;
    const meta = idx.find((s) => s.sessionId === sessionId);
    if (!meta) return false;
    delete meta.closedAt;
    delete meta.closedBy; // it's open again; the next close records its own reason
    meta.lastTurnEndedAt = Date.now();
    this.#writeIndex(dock, idx);
    return true;
  }

  /** Docks that have any persisted session. */
  docks(): string[] {
    try {
      return readdirSync(this.#root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  #index(dock: string): SessionMeta[] {
    try {
      return JSON.parse(readFileSync(this.#file(dock, 'sessions.json'), 'utf8')) as SessionMeta[];
    } catch {
      return [];
    }
  }

  #writeIndex(dock: string, idx: SessionMeta[]): void {
    this.#writeJson(this.#file(dock, 'sessions.json'), idx);
  }

  #file(dock: string, name: string): string {
    return join(this.#root, sanitize(dock), name);
  }

  /** atomic-ish write: tmp + rename so a crash never half-writes a transcript. */
  #writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }
}

/** keep dock names filesystem-safe. */
function sanitize(dock: string): string {
  return dock.replace(/[^a-zA-Z0-9._-]/g, '_');
}
