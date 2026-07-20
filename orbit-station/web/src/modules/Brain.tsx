/**
 * Brain — the server-brain test console. A fake phone + a turn inspector.
 *
 * Two data paths, deliberately separate:
 *   - a SECOND WebSocket as a `device` peer (dock/<phone>, caps voice+face):
 *     the exact tenancy path a real phone takes — turn-request up, speak /
 *     tool-call / turn-status down (tool-calls auto-acked, fire-and-forget).
 *   - the console's normal browser socket: the brain's `brain-debug` stream
 *     on the obs topic (full text/thinking deltas, TTFT, per-step usage) —
 *     browsers-only, never sent to devices.
 *
 * NOTE: claiming a dock whose real phone is online DISPLACES it (newest-wins
 * = the hardware-swap rule) — hence the `web-test` default dock.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStationEvents } from '../lib/useStation';
import type { EventFrame } from '../lib/protocol';

// ── types ────────────────────────────────────────────────────────────────────

interface StepDebug {
  step: number;
  startedAt: number;
  ttftMs?: number;
  /** reasoning phase: first thinking token → first answer token. */
  thinkingMs?: number;
  /** step start → first ANSWER token (ttftMs counts thinking tokens too). */
  ttftTextMs?: number;
  ms?: number;
  stopReason?: string;
  /** the step's error text when it errored (provider body, etc.). */
  error?: string;
  model?: string;
  usage?: { input: number; output: number; total: number; cost?: number };
  tools: { name: string; args?: unknown; ms?: number; isError?: boolean; result?: string; at: number }[];
}

interface TurnDebug {
  turnId: string;
  text: string;
  model?: string;
  thinkingLevel?: string;
  historyMessages?: number;
  /** STT confidence for a HEARD turn (Whisper's own metrics — why it was trusted). */
  stt?: { confTier?: string; avgLogprob?: number | null; noSpeechProb?: number | null; compressionRatio?: number | null };
  startedAt: number;
  steps: StepDebug[];
  streamText: string;
  thinkingText: string;
  speaks: { seq: number; text: string; at: number }[];
  state?: 'done' | 'failed' | 'cancelled';
  code?: string;
  error?: string;
  totalMs?: number;
  /** true = hydrated from the obs tree on resume (a prior turn), not live. */
  resumed?: boolean;
}

interface SessionMeta {
  sessionId: string; openedAt: number; lastTurnEndedAt: number;
  closedAt?: number; turns: number; summary?: string;
}

interface BrainConfig { brainModel: string; brainThinkingLevel: string; brainPersona: string; brainTurnTimeoutMs: number }
interface KeyStatus {
  provider: string;
  keyName: string | null;
  keySet: boolean;
  paidFallback: { keyName: string; keySet: boolean } | null;
  alwaysPaid: boolean;
}
interface ConfirmReq { reqId: string; toolCallId: string; turnId: string; summary: string; detail: string }

/** The dock's full brain context (GET /api/brain/:dock/profile). */
interface DockProfile {
  dock: string;
  config: {
    brainModel: string; brainPersona: string; brainThinkingLevel: string; brainTurnTimeoutMs: number;
    brainSkills: boolean; brainFileAccess: boolean; brainAlwaysPaid: boolean;
    brainGrants: Record<string, string[]>;
  };
  key: KeyStatus;
  composition: { components: { component: string; kind?: string; caps?: string[]; online: boolean; build?: number }[] };
  memory: string | null;
  skills: { name: string; description: string }[];
  sessionCount: number;
  openSession: string | null;
  systemPrompt: string;
  // 2c test surface: the live attention state + the grounding block the next turn
  // would inject (docs/perception-to-brain.md Phase 2c).
  state?: 'idle' | 'listening' | 'speaking' | 'thinking';
  listening?: boolean;
  grounding?: string | null;
}

/** 4c memory inspector (docs/perception-to-brain.md Decision 4). */
interface MemoryItem {
  id: string; type: string; subject: string; claim: string; confidence: number;
  derivation: string; status: string; createdAt: number; validFrom: number;
}
interface MemoryView { count: number; subjects: string[]; memories: MemoryItem[] }
interface MemoryDetail { memory: MemoryItem; lineage: { sourceKind: string; sourceId: string }[] }

/** 5c proactive attention gate (docs/perception-to-brain.md Phase 5). */
interface GateDecision { ts: number; dockId: string; raised: boolean; detail: string }

/** A condensed prior exchange from a resumed/open session's transcript. */
interface PastExchange { user: string; reply: string; userAt?: number; replyAt?: number }

/** Map a persisted observability Session tree → the SAME TurnDebug objects the
 *  live brain-debug stream builds, so a resumed session renders with the full
 *  inspector (steps, tools, tokens, cost, ttft) — not a flat reply. The obs
 *  StepEnd now carries the rich timings + cost (server enrichment), so resumed
 *  turns match live exactly. */
function turnsFromObs(session: { turns?: ObsTurn[] }): TurnDebug[] {
  return (session.turns ?? []).map((t) => {
    const steps: StepDebug[] = (t.steps ?? []).map((s) => ({
      step: s.index,
      startedAt: s.startedAt,
      ttftMs: s.ttftMs ?? (s.streamStartedAt != null ? s.streamStartedAt - s.startedAt : undefined),
      thinkingMs: s.thinkingMs,
      ttftTextMs: s.ttftTextMs,
      ms: s.ms ?? (s.endedAt != null ? s.endedAt - s.startedAt : undefined),
      stopReason: s.stopReason,
      error: s.error,
      model: s.model,
      usage: s.usage ? {
        input: s.usage.inputTokens ?? 0, output: s.usage.outputTokens ?? 0,
        total: s.usage.totalTokens ?? 0, cost: s.usage.cost,
      } : undefined,
      tools: (s.tools ?? []).map((tc) => ({
        name: tc.toolName, args: tc.args, isError: tc.isError, result: tc.result,
        ms: tc.endedAt != null ? tc.endedAt - tc.startedAt : undefined, at: tc.startedAt,
      })),
    }));
    const reply = steps.map((s) => s.tools).length // assistant text lives on step.text in obs
      ? (t.steps ?? []).map((s) => s.text ?? '').filter(Boolean).join(' ')
      : '';
    // A turn FAILED only if its LAST step errored — an early step error that
    // was recovered (e.g. free-key 429 → paid retry succeeds) is not a failure.
    // Tool errors don't fail the turn either; the model narrates and continues.
    const lastStep = steps[steps.length - 1];
    const hadErr = lastStep?.stopReason === 'error';
    return {
      turnId: t.turnId,
      text: t.trigger?.text ?? '',
      startedAt: t.startedAt,
      steps,
      streamText: reply,
      thinkingText: '',
      speaks: [],
      state: hadErr ? 'failed' : 'done',
      totalMs: t.endedAt != null ? t.endedAt - t.startedAt : undefined,
      resumed: true,
    } satisfies TurnDebug;
  });
}

interface ObsTurn {
  turnId: string; startedAt: number; endedAt?: number;
  trigger?: { kind: string; text?: string };
  steps?: ObsStep[];
}
interface ObsStep {
  index: number; startedAt: number; endedAt?: number; streamStartedAt?: number;
  model?: string; stopReason?: string; error?: string; text?: string;
  ms?: number; ttftMs?: number; thinkingMs?: number; ttftTextMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number };
  tools?: { toolName: string; args?: unknown; isError?: boolean; result?: string; startedAt: number; endedAt?: number }[];
}

function pastFromHistory(messages: unknown[]): PastExchange[] {
  const out: PastExchange[] = [];
  let cur: PastExchange | null = null;
  for (const m of messages as Array<{ role?: string; content?: unknown; timestamp?: number }>) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : ((m.content as Array<{ type?: string; text?: string }>) ?? [])
            .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (cur) out.push(cur);
      cur = { user: text, reply: '', userAt: m.timestamp };
    } else if (m.role === 'assistant' && cur) {
      const text = ((m.content as Array<{ type?: string; text?: string }>) ?? [])
        .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (text) { cur.reply += (cur.reply ? ' ' : '') + text; cur.replyAt ??= m.timestamp; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** exact HH:MM:SS.mmm timestamp for the chat log. */
const fmtTime = (ms?: number) => {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const MODEL_PRESETS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-sonnet-4-6',
  'openai/gpt-4o-mini',
  'openai-compatible/qwen3:8b@http://localhost:11434/v1',
];
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const fmtMs = (ms?: number) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const fmtCost = (c?: number) => (c == null || c === 0 ? '' : `$${c.toFixed(5)}`);
// Countdown label for a TIMED quiet: "M:SS" under an hour, "Hh Mm" above.
const fmtQuietLeft = (secs: number) =>
  secs >= 3600
    ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
    : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

// ── component ────────────────────────────────────────────────────────────────

export function Brain() {
  const [dock, setDock] = useState('web-test');
  const [connected, setConnected] = useState(false);
  const [brainReady, setBrainReady] = useState(false);
  const [input, setInput] = useState('');
  const [turnActive, setTurnActive] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [cfg, setCfg] = useState<BrainConfig | null>(null);
  const [cfgDirty, setCfgDirty] = useState<Partial<BrainConfig>>({});
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [profile, setProfile] = useState<DockProfile | null>(null);
  // QUIET MODE (🤐): { quiet, until } from GET /api/brain/:dock/quiet. until>0 =
  // a timed lock (the keep_quiet tool); the UI toggle sets the indefinite form.
  const [quiet, setQuiet] = useState<{ quiet: boolean; until: number }>({ quiet: false, until: 0 });
  const [nowTick, setNowTick] = useState(Date.now()); // ticks the quiet countdown
  const [showContext, setShowContext] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  // 2c test surface: the self-thought box + grounding preview toggle.
  const [thought, setThought] = useState('');
  const [showGrounding, setShowGrounding] = useState(false);
  // 4c memory inspector: this dock's memories + the selected one's lineage.
  const [showMemory, setShowMemory] = useState(false);
  const [memData, setMemData] = useState<MemoryView | null>(null);
  const [memQuery, setMemQuery] = useState('');
  const [memSel, setMemSel] = useState<MemoryDetail | null>(null);
  // 5c proactive gate: enabled state + recent decisions log.
  const [gate, setGate] = useState<{ enabled: boolean; recent: GateDecision[] } | null>(null);
  const [showGate, setShowGate] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmReq | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // collapse any expanded step when the selected turn changes
  useEffect(() => { setExpandedStep(null); }, [selected]);
  const [past, setPast] = useState<PastExchange[]>([]);
  const [, bump] = useState(0); // re-render tick for ref-held turn map

  const ws = useRef<WebSocket | null>(null);
  const turns = useRef<Map<string, TurnDebug>>(new Map());
  const order = useRef<string[]>([]);
  const activeTurnId = useRef('');
  const chatScroll = useRef<HTMLDivElement>(null);
  const inputEl = useRef<HTMLInputElement>(null);
  const dockRef = useRef(dock);
  dockRef.current = dock;

  const rerender = useCallback(() => bump((n) => n + 1), []);

  // ── debug stream (browser socket, obs topic, kind brain-debug) ────────────
  const onDebug = useCallback((e: EventFrame) => {
    if (e.kind !== 'brain-debug') return;
    const p = e.payload as Record<string, any>;
    if (p.dock !== dockRef.current || !p.turnId) return;
    let t = turns.current.get(p.turnId);
    if (!t && p.type !== 'turn-start') return;
    switch (p.type) {
      case 'turn-start':
        t = {
          turnId: p.turnId, text: p.text ?? '', model: p.model, thinkingLevel: p.thinkingLevel,
          historyMessages: p.historyMessages, stt: p.stt, startedAt: p.ts,
          steps: [], streamText: '', thinkingText: '', speaks: [],
        };
        turns.current.set(p.turnId, t);
        order.current.push(p.turnId);
        if (order.current.length > 12) turns.current.delete(order.current.shift()!);
        setSelected(p.turnId);
        break;
      case 'step-start':
        t!.steps.push({ step: p.step, startedAt: p.ts, tools: [] });
        break;
      case 'ttft': {
        const s = t!.steps.find((x) => x.step === p.step);
        if (s) s.ttftMs = p.ms;
        break;
      }
      case 'text-delta': t!.streamText += p.delta ?? ''; break;
      case 'thinking-delta': t!.thinkingText += p.delta ?? ''; break;
      case 'speak': t!.speaks.push({ seq: p.seq, text: p.text, at: p.ts }); break;
      case 'tool-start':
        t!.steps.at(-1)?.tools.push({ name: p.name, args: p.args, at: p.ts });
        break;
      case 'tool-end': {
        const tool = t!.steps.at(-1)?.tools.find((x) => x.name === p.name && x.ms == null);
        if (tool) { tool.ms = p.ms; tool.isError = p.isError; tool.result = p.result; }
        break;
      }
      case 'step-end': {
        const s = t!.steps.find((x) => x.step === p.step);
        if (s) { s.ms = p.ms; s.ttftMs = p.ttftMs ?? s.ttftMs; s.thinkingMs = p.thinkingMs; s.ttftTextMs = p.ttftTextMs; s.stopReason = p.stopReason; s.error = p.error; s.model = p.model; s.usage = p.usage; }
        break;
      }
      case 'turn-end':
        t!.state = p.state; t!.code = p.code; t!.error = p.error; t!.totalMs = p.totalMs;
        break;
    }
    rerender();
  }, [rerender]);
  useStationEvents('obs', onDebug);

  useEffect(() => {
    chatScroll.current?.scrollTo({ top: chatScroll.current.scrollHeight });
  });

  // ── config (model control) ────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/config');
      const data = await r.json() as { entries: { key: string; value: unknown }[] };
      const v = (k: string) => data.entries.find((e) => e.key === k)?.value;
      setCfg({
        brainModel: String(v('brainModel') ?? ''),
        brainThinkingLevel: String(v('brainThinkingLevel') ?? 'off'),
        brainPersona: String(v('brainPersona') ?? ''),
        brainTurnTimeoutMs: Number(v('brainTurnTimeoutMs') ?? 60000),
      });
      setCfgDirty({});
      // which API key the current model resolves to (name + set/unset + fallback)
      try {
        const kr = await fetch('/api/brain/keystatus');
        if (kr.ok) setKeyStatus(await kr.json() as KeyStatus);
      } catch { /* ignore */ }
    } catch { /* station down */ }
  }, []);
  useEffect(() => { void loadConfig(); }, [loadConfig]);

  // the dock's full brain context (config, key, composition, memory, skills,
  // system prompt) — loaded on connect + after any config change.
  // QUIET MODE (🤐): read state. The console toggle (toggleQuiet, below) is always
  // the INDEFINITE form — a timed quiet only comes from the agent's keep_quiet
  // tool. Off always wins, even over a timed lock. Refreshed with every profile
  // load; the station drives the on-face 🤐 independently.
  const loadQuiet = useCallback(async (d: string) => {
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(d)}/quiet`);
      if (r.ok) setQuiet(await r.json() as { quiet: boolean; until: number });
    } catch { /* station down */ }
  }, []);

  const loadProfile = useCallback(async (d: string) => {
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(d)}/profile`);
      if (r.ok) setProfile(await r.json() as DockProfile);
    } catch { /* ignore */ }
    void loadQuiet(d); // keep the 🤐 badge in step with every profile refresh
  }, [loadQuiet]);

  // Tick the quiet countdown while a TIMED quiet is live; re-poll once it lapses
  // so the badge clears when the station auto-unlocks (server-owned expiry).
  useEffect(() => {
    if (!(quiet.quiet && quiet.until > 0)) return;
    const id = setInterval(() => {
      const now = Date.now();
      setNowTick(now);
      if (now >= quiet.until) void loadQuiet(dockRef.current.trim() || 'web-test');
    }, 500);
    return () => clearInterval(id);
  }, [quiet.quiet, quiet.until, loadQuiet]);

  const applyConfig = async () => {
    if (Object.keys(cfgDirty).length === 0) return;
    await fetch('/api/config', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfgDirty),
    });
    await loadConfig();
    await loadProfile(dockRef.current.trim() || 'web-test');
  };
  const effective = { ...cfg, ...cfgDirty } as BrainConfig | null;
  const dirty = Object.keys(cfgDirty).length > 0;

  // ── fake-phone socket ─────────────────────────────────────────────────────
  const refreshSessions = useCallback(async (d: string) => {
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(d)}/sessions`);
      if (r.ok) setSessions(await r.json());
    } catch { /* ignore */ }
  }, []);

  /** hydrate the transcript with the open session's prior exchanges. */
  const loadHistory = useCallback(async (d: string) => {
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(d)}/history`);
      if (r.ok) setPast(pastFromHistory(await r.json()));
    } catch { /* ignore */ }
  }, []);

  const resumeSession = useCallback(async (sessionId: string) => {
    const d = dockRef.current.trim() || 'web-test';
    const r = await fetch(`/api/brain/${encodeURIComponent(d)}/session/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
    if (!r.ok) return;
    turns.current.clear();
    order.current = [];
    setSelected(null);
    setPast([]);
    await refreshSessions(d);
    // Hydrate the rich inspector from the persisted obs tree (same UI as live).
    // Fall back to the flat transcript strip only if obs has no trace.
    try {
      const o = await fetch(`/api/observability/sessions/${encodeURIComponent(sessionId)}`);
      if (o.ok) {
        const tree = await o.json();
        const hydrated = turnsFromObs(tree);
        if (hydrated.length > 0) {
          for (const t of hydrated) { turns.current.set(t.turnId, t); order.current.push(t.turnId); }
          rerender();
          return;
        }
      }
    } catch { /* fall through to flat history */ }
    await loadHistory(d);
  }, [refreshSessions, loadHistory, rerender]);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (!window.confirm(`Delete session ${sessionId}? This removes its transcript and trace permanently.`)) return;
    const d = dockRef.current.trim() || 'web-test';
    const r = await fetch(`/api/brain/${encodeURIComponent(d)}/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (r.status === 409) { window.alert('That session is currently open — end it first.'); return; }
    // drop the obs trace too
    await fetch(`/api/observability/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
    await refreshSessions(d);
  }, [refreshSessions]);

  const pub = (topic: string, kind: string, payload: unknown) =>
    ws.current?.send(JSON.stringify({ t: 'publish', topic, kind, payload }));

  // approve / deny / approve-all a parked confirm (mutating code/file tool).
  // 'all' latches session-wide auto-approval at the station.
  const resolveConfirm = (mode: 'approve' | 'deny' | 'all') => {
    const c = confirm;
    if (!c) return;
    setConfirm(null);
    pub('agent', 'tool-result', {
      reqId: c.reqId, toolCallId: c.toolCallId, turnId: c.turnId,
      content: mode === 'all' ? 'approved-all' : mode === 'approve' ? 'approved' : 'denied',
      isError: false,
    });
  };

  const disconnect = useCallback(() => {
    ws.current?.close();
    ws.current = null;
    setConnected(false); setBrainReady(false); setTurnActive(false);
  }, []);

  const connect = useCallback(() => {
    disconnect();
    const d = dockRef.current.trim() || 'web-test';
    const sock = new WebSocket(wsUrl());
    ws.current = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({
        t: 'hello', role: 'device', id: `web-phone-${Math.random().toString(36).slice(2, 8)}`,
        dock: d, component: 'phone', kind: 'web-test-phone', caps: ['voice', 'face'],
        label: `${d} console test phone`,
      }));
      sock.send(JSON.stringify({ t: 'subscribe', topics: ['agent'] }));
      // deterministic resync handshake: hello AFTER subscribing (the
      // peer-joined push can race the subscribe frame server-side)
      sock.send(JSON.stringify({ t: 'publish', topic: 'agent', kind: 'hello', payload: {} }));
      setConnected(true);
      void refreshSessions(d);
      void loadHistory(d);
      void loadProfile(d);
      setTimeout(() => inputEl.current?.focus(), 50);
    };
    sock.onclose = () => { setConnected(false); setBrainReady(false); };
    sock.onmessage = (m) => {
      let f: { t?: string; kind?: string; payload?: any; message?: string };
      try { f = JSON.parse(m.data as string); } catch { return; }
      if (f.t !== 'event') return;
      const p = f.payload ?? {};
      if (f.kind === 'brain-status') setBrainReady(true);
      else if (f.kind === 'tool-call') {
        // confirm (mutating code/file tool) → show an approve/deny dialog and
        // ack on the user's choice; everything else auto-acks (fake phone).
        if (p.name === 'confirm') {
          setConfirm({
            reqId: p.reqId, toolCallId: p.toolCallId, turnId: p.turnId,
            summary: String(p.args?.summary ?? 'Allow this action?'),
            detail: String(p.args?.detail ?? ''),
          });
        } else {
          pub('agent', 'tool-result', {
            reqId: p.reqId, toolCallId: p.toolCallId, turnId: p.turnId,
            content: `${p.name} dispatched (console fake phone)`, isError: false,
          });
        }
      } else if (f.kind === 'turn-status') {
        if (p.turnId !== activeTurnId.current) return;
        if (p.state === 'done' || p.state === 'failed' || p.state === 'cancelled') {
          setTurnActive(false);
          pub('agent', 'speech-status', { turnId: p.turnId, speaking: true });
          setTimeout(() => pub('agent', 'speech-status', { turnId: p.turnId, speaking: false }), 250);
          void refreshSessions(dockRef.current.trim() || 'web-test');
          setTimeout(() => inputEl.current?.focus(), 50);
        }
      }
    };
    sock.onerror = () => sock.close();
  }, [disconnect, refreshSessions, loadHistory, loadProfile]);
  useEffect(() => () => disconnect(), [disconnect]);

  // Send a user utterance as a turn (the console acts as a test phone). Shared by
  // the text box and the 2c/3c quick-test buttons.
  const sendUtterance = (text: string, contextState?: string) => {
    if (!text.trim() || !connected || turnActive) return;
    const id = `t-${Math.random().toString(36).slice(2, 10)}`;
    activeTurnId.current = id;
    setTurnActive(true);
    pub('agent', 'transcript', { utteranceId: id, text, isFinal: true });
    pub('agent', 'turn-request', {
      turnId: id,
      trigger: { kind: 'user', text },
      // default: a no-camera test phone. The perceive-now button overrides this so
      // the model actually reaches for force_get_current (3c verification).
      context: { state: contextState ?? 'You are talking through the station console (a test phone, no camera).' },
    });
  };

  const send = () => {
    const text = input.trim();
    if (!text || !connected || turnActive) return;
    setInput('');
    sendUtterance(text);
  };

  const cancel = () => {
    if (!turnActive) return;
    pub('agent', 'turn-cancel', { turnId: activeTurnId.current });
  };

  // 2c: fire a SELF-THOUGHT (docs/perception-to-brain.md Phase 1). The dock routes
  // it as an autonomous turn (trigger.kind:'self') — user turns still win; it defers
  // while listening/speaking. Watch it appear in the turn stream tagged 'self'.
  const think = async () => {
    const text = thought.trim();
    if (!text || !connected) return;
    setThought('');
    const d = dockRef.current.trim() || 'web-test';
    await fetch(`/api/brain/${encodeURIComponent(d)}/think`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await loadProfile(d); // refresh the state pill
  };

  // 2c: toggle the STUBBED listening state (user mid-utterance). No real mic signal
  // yet (Phase A1) — this is the test seam so the thought-defer path is clickable.
  const toggleListening = async () => {
    const d = dockRef.current.trim() || 'web-test';
    const next = !(profile?.listening ?? false);
    await fetch(`/api/brain/${encodeURIComponent(d)}/listening`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listening: next }),
    });
    await loadProfile(d);
  };

  const toggleQuiet = async () => {
    const d = dockRef.current.trim() || 'web-test';
    const next = !quiet.quiet;
    await fetch(`/api/brain/${encodeURIComponent(d)}/quiet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next ? { on: true } : { on: false }),
    });
    await loadQuiet(d);
  };

  // 4c: load this dock's memories (optionally filtered by a semantic query).
  const loadMemory = async (query?: string) => {
    const d = dockRef.current.trim() || 'web-test';
    const u = new URL(`/api/perception/memory`, location.origin);
    u.searchParams.set('dock', d);
    if (query?.trim()) u.searchParams.set('query', query.trim());
    try {
      const r = await fetch(u.toString());
      if (r.ok) setMemData(await r.json() as MemoryView);
    } catch { /* station down */ }
  };
  const inspectMemory = async (id: string) => {
    try {
      const r = await fetch(`/api/perception/memory/item/${encodeURIComponent(id)}`);
      if (r.ok) setMemSel(await r.json() as MemoryDetail);
    } catch { /* ignore */ }
  };
  const forgetMemory = async (id: string) => {
    await fetch(`/api/perception/memory/item/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setMemSel(null);
    await loadMemory(memQuery);
  };

  // 5c: read the proactive-gate state + recent decisions; toggle it on/off.
  const loadGate = async () => {
    try {
      const r = await fetch('/api/perception/gate');
      if (r.ok) setGate(await r.json() as { enabled: boolean; recent: GateDecision[] });
    } catch { /* station down */ }
  };
  const toggleGate = async () => {
    const next = !(gate?.enabled ?? false);
    await fetch('/api/perception/gate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    await loadGate();
  };

  const endSession = async () => {
    const d = dockRef.current.trim() || 'web-test';
    await fetch(`/api/brain/${encodeURIComponent(d)}/session/end`, { method: 'POST' });
    setPast([]);
    turns.current.clear();
    order.current = [];
    setSelected(null);
    void refreshSessions(d);
  };

  // ── derived ───────────────────────────────────────────────────────────────
  const turnList = order.current.map((id) => turns.current.get(id)!).filter(Boolean);
  const sel = (selected != null ? turns.current.get(selected) : undefined) ?? turnList.at(-1);
  const open = sessions.find((s) => s.closedAt == null);
  const totals = useMemo(() => {
    if (!sel) return null;
    const input = sel.steps.reduce((a, s) => a + (s.usage?.input ?? 0), 0);
    const output = sel.steps.reduce((a, s) => a + (s.usage?.output ?? 0), 0);
    const cost = sel.steps.reduce((a, s) => a + (s.usage?.cost ?? 0), 0);
    return { input, output, cost };
  }, [sel, sel?.totalMs, sel?.steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="brain">
      <style>{CSS}</style>

      {/* ── status strip ── */}
      <div className="br-strip">
        <span className="br-logo">◈ BRAIN</span>
        <span className="br-sep" />
        <label className="br-lbl">dock</label>
        <input className="br-in br-dock" value={dock} disabled={connected} onChange={(e) => setDock(e.target.value)} />
        {!connected
          ? <button className="br-btn acc" onClick={connect}>connect</button>
          : <button className="br-btn" onClick={disconnect}>disconnect</button>}
        <span className="br-sep" />
        <Led on={connected} pulse={false} label="link" />
        <Led on={brainReady} pulse={turnActive} label="brain" />
        <span className="br-sep" />
        {open
          ? <span className="br-chip mono" title={`opened ${new Date(open.openedAt).toLocaleTimeString()}`}>{open.sessionId} · {open.turns}t</span>
          : <span className="br-chip dim">no session</span>}
        <div className="spacer" />
        <button className="br-btn" onClick={endSession} disabled={!open}>end session</button>
      </div>

      {/* ── model strip ── */}
      {effective && (
        <div className="br-strip">
          <label className="br-lbl">model</label>
          <select className="br-in" value={MODEL_PRESETS.includes(effective.brainModel) ? effective.brainModel : '_custom'}
            onChange={(e) => { if (e.target.value !== '_custom') setCfgDirty((d) => ({ ...d, brainModel: e.target.value })); }}>
            {MODEL_PRESETS.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value="_custom">custom…</option>
          </select>
          <input className="br-in br-model mono" value={effective.brainModel}
            onChange={(e) => setCfgDirty((d) => ({ ...d, brainModel: e.target.value }))} />
          <label className="br-lbl">think</label>
          <div className="br-seg">
            {THINKING_LEVELS.map((l) => (
              <button key={l} className={effective.brainThinkingLevel === l ? 'on' : ''}
                onClick={() => setCfgDirty((d) => ({ ...d, brainThinkingLevel: l }))}>{l}</button>
            ))}
          </div>
          <label className="br-lbl">timeout</label>
          <input className="br-in br-num mono" type="number" value={effective.brainTurnTimeoutMs}
            onChange={(e) => setCfgDirty((d) => ({ ...d, brainTurnTimeoutMs: Number(e.target.value) }))} />
          <button className={`br-btn ${dirty ? 'acc glow' : ''}`} onClick={applyConfig} disabled={!dirty}>apply</button>
          {keyStatus && (
            <span className="br-key" title={`provider: ${keyStatus.provider}`}>
              <label className="br-lbl">key</label>
              {keyStatus.keyName ? (
                <span className={`br-key-name ${keyStatus.keySet ? 'ok' : 'bad'}`}
                  title={keyStatus.keySet ? 'set in station .env' : 'NOT set in station .env'}>
                  <span className="br-key-dot" />{keyStatus.keyName}
                  {keyStatus.alwaysPaid && <span className="br-key-tag">paid</span>}
                </span>
              ) : (
                <span className="br-key-name dim" title="local/LAN model — no API key">— none (local)</span>
              )}
              {keyStatus.paidFallback && (
                <span className={`br-key-fallback ${keyStatus.paidFallback.keySet ? 'ok' : 'bad'}`}
                  title={keyStatus.paidFallback.keySet
                    ? 'paid key is set — used as fallback on quota/overload'
                    : 'paid fallback key is NOT set'}>
                  ↳ fallback {keyStatus.paidFallback.keyName}
                </span>
              )}
            </span>
          )}
          {connected && profile && (
            <button className={`br-btn ${showTasks ? 'acc' : ''}`} style={{ marginLeft: 'auto' }}
              onClick={() => setShowTasks((v) => !v)}>
              {showTasks ? '▾' : '▸'} tasks
            </button>
          )}
          {connected && profile && (
            <button className={`br-btn ${showContext ? 'acc' : ''}`}
              onClick={() => setShowContext((v) => !v)}>
              {showContext ? '▾' : '▸'} dock context
            </button>
          )}
        </div>
      )}

      {/* ── 2c: perception test surface — self-thoughts, attention state, grounding
            (docs/perception-to-brain.md Phase 2c). Fire a thought and watch it route
            in the turn stream (tagged 'self'); flip listening to see it defer. ── */}
      {connected && (
        <div className="br-strip br-percept">
          <span className="br-logo" title="perception → agent test surface">👁 PERCEPT</span>
          <span className="br-sep" />
          <label className="br-lbl">state</label>
          <span className={`br-state br-state-${profile?.state ?? 'idle'}`} title="live attention state">
            {profile?.state ?? 'idle'}
          </span>
          <button className={`br-btn ${profile?.listening ? 'acc glow' : ''}`} onClick={toggleListening}
            title="stub: user mid-utterance (no real mic yet). A thought DEFERS while on.">
            {profile?.listening ? '🎙 listening ON' : '🎙 listening off'}
          </button>
          <button className={`br-btn ${quiet.quiet ? 'acc glow' : ''}`} onClick={toggleQuiet}
            title="Quiet mode: the dock keeps hearing + idling but makes NO replies or remarks. Toggle is indefinite; a timed quiet comes from the keep_quiet tool. Off always wins.">
            {quiet.quiet
              ? (quiet.until > 0
                ? `🤐 quiet · ${fmtQuietLeft(Math.max(0, Math.ceil((quiet.until - nowTick) / 1000)))}`
                : '🤐 quiet ON')
              : '🤐 quiet off'}
          </button>
          <span className="br-sep" />
          <label className="br-lbl">think</label>
          <input className="br-in" style={{ flex: 1, minWidth: 160 }} value={thought}
            placeholder="a self-thought, e.g. 'the user has looked stuck for a while'"
            onChange={(e) => setThought(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void think(); }} />
          <button className="br-btn acc" onClick={think} disabled={!thought.trim()}>fire thought</button>
          <span className="br-sep" />
          {/* 3c: a user turn worded to trigger force_get_current — verify the tool
              fires + its call shows in the inspector (no need to type). */}
          <button className="br-btn" onClick={() => sendUtterance('what do you see right now? look right now.',
            'You have a live camera and microphone. Use your perception tools to check the live moment.')}
            disabled={turnActive} title="sends a user turn that should call force_get_current">
            🔎 perceive now
          </button>
          <button className={`br-btn ${showGrounding ? 'acc' : ''}`} onClick={() => { setShowGrounding((v) => !v); if (profile) void loadProfile(profile.dock); }}>
            {showGrounding ? '▾' : '▸'} grounding
          </button>
          <button className={`br-btn ${showMemory ? 'acc' : ''}`} onClick={() => { const n = !showMemory; setShowMemory(n); if (n) void loadMemory(); }}>
            {showMemory ? '▾' : '▸'} memory
          </button>
          <button className={`br-btn ${showGate ? 'acc' : ''}`} onClick={() => { const n = !showGate; setShowGate(n); if (n) void loadGate(); }}>
            {showGate ? '▾' : '▸'} proactivity
          </button>
        </div>
      )}
      {/* grounding preview — the exact perception block the NEXT turn would inject. */}
      {connected && showGrounding && (
        <pre className="br-grounding">
          {profile?.grounding?.trim() || '(no perception grounding yet — cold dock, no summary + no recent records)'}
        </pre>
      )}

      {/* 4c: memory inspector — the dock's unified memory (Decision 4). List/search,
          click a row for its lineage ("why do I believe this"), forget. */}
      {connected && showMemory && (
        <div className="br-mem">
          <div className="br-mem-bar">
            <span className="br-mem-count">{memData?.count ?? 0} memories</span>
            {(memData?.subjects ?? []).length > 0 && (
              <span className="br-mem-subjects">about: {memData!.subjects.join(', ')}</span>
            )}
            <input className="br-in" style={{ flex: 1, minWidth: 140 }} value={memQuery}
              placeholder="semantic search, e.g. 'what do I know about guru'"
              onChange={(e) => setMemQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadMemory(memQuery); }} />
            <button className="br-btn" onClick={() => void loadMemory(memQuery)}>search</button>
            <button className="br-btn" onClick={() => { setMemQuery(''); void loadMemory(); }}>all</button>
          </div>
          <div className="br-mem-body">
            <div className="br-mem-list">
              {(memData?.memories ?? []).length === 0 && <div className="dim" style={{ padding: 8 }}>no memories yet</div>}
              {(memData?.memories ?? []).map((m) => (
                <div key={m.id} className={`br-mem-row ${memSel?.memory.id === m.id ? 'sel' : ''}`} onClick={() => void inspectMemory(m.id)}>
                  <span className={`br-mem-type t-${m.type}`}>{m.type}</span>
                  {m.subject && <span className="br-mem-subj">{m.subject}</span>}
                  <span className="br-mem-claim">{m.claim}</span>
                  <span className="br-mem-conf" title="confidence">{m.confidence.toFixed(2)}</span>
                </div>
              ))}
            </div>
            {memSel && (
              <div className="br-mem-detail">
                <div className="br-mem-detail-h">why do I believe this</div>
                <div className="br-mem-claim-lg">"{memSel.memory.claim}"</div>
                <div className="br-kv"><span className="br-kv-k">type</span><span className="br-kv-v">{memSel.memory.type}{memSel.memory.subject ? ` · ${memSel.memory.subject}` : ''}</span></div>
                <div className="br-kv"><span className="br-kv-k">deriv</span><span className="br-kv-v">{memSel.memory.derivation} · conf {memSel.memory.confidence.toFixed(2)}</span></div>
                <div className="br-kv"><span className="br-kv-k">when</span><span className="br-kv-v">{new Date(memSel.memory.createdAt).toLocaleString()}</span></div>
                <div className="br-mem-detail-h" style={{ marginTop: 8 }}>lineage</div>
                {memSel.lineage.length === 0
                  ? <div className="dim" style={{ fontSize: 11 }}>told / inferred directly (no recorded source)</div>
                  : memSel.lineage.map((e, i) => <div key={i} className="br-mem-lin mono">{e.sourceKind}:{e.sourceId}</div>)}
                <button className="br-btn" style={{ marginTop: 10 }} onClick={() => void forgetMemory(memSel.memory.id)}>forget this</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5c: proactive attention gate — toggle + recent decisions (Phase 5). */}
      {connected && showGate && (
        <div className="br-gate">
          <div className="br-gate-bar">
            <button className={`br-btn ${gate?.enabled ? 'acc glow' : ''}`} onClick={toggleGate}>
              {gate?.enabled ? '● proactivity ON' : '○ proactivity off'}
            </button>
            <span className="dim" style={{ fontSize: 11 }}>
              the robot raises its own thoughts (arrivals, strong emotions) — auto-fires self-thoughts
            </span>
            <button className="br-btn" style={{ marginLeft: 'auto' }} onClick={() => void loadGate()}>refresh</button>
          </div>
          <div className="br-gate-log">
            {(gate?.recent ?? []).length === 0 && <div className="dim" style={{ padding: 8, fontSize: 11 }}>no gate decisions yet {gate?.enabled ? '— waiting for a perception event' : '(enable proactivity first)'}</div>}
            {(gate?.recent ?? []).map((d, i) => (
              <div key={i} className={`br-gate-row ${d.raised ? 'raised' : ''}`}>
                <span className="br-gate-time mono">{new Date(d.ts).toLocaleTimeString()}</span>
                <span className={`br-gate-verb ${d.raised ? 'on' : ''}`}>{d.raised ? 'RAISED' : 'quiet'}</span>
                <span className="br-gate-detail">{d.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── tasks: definitions + running instances (docs/tasks.md §8) ── */}
      {connected && profile && showTasks && <TasksPanel dock={profile.dock} />}

      {/* ── dock context: this dock's full brain state in one place ── */}
      {connected && profile && showContext && (
        <DockContext
          p={profile}
          onPatchConfig={async (partial) => {
            await fetch('/api/config', {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(partial),
            });
            await loadConfig();
            await loadProfile(profile.dock);
          }}
          onInstallSkill={async (content) => {
            const r = await fetch(`/api/brain/${encodeURIComponent(profile.dock)}/skills`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content }),
            });
            const body = await r.json().catch(() => ({}));
            await loadProfile(profile.dock);
            return r.ok ? { ok: true, name: body.name } : { ok: false, error: body.error ?? 'install failed' };
          }}
          onRemoveSkill={async (name) => {
            await fetch(`/api/brain/${encodeURIComponent(profile.dock)}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
            await loadProfile(profile.dock);
          }}
        />
      )}

      {/* ── main ── */}
      <div className="br-grid">
        <div className="br-panel br-chat">
          <div className="br-scroll" ref={chatScroll}>
            {turnList.length === 0 && (
              <div className="br-empty">
                <div className="br-empty-glyph">◈</div>
                <div>{connected ? 'say something below — the whole turn lands here live' : 'connect to start a session'}</div>
                <div className="dim">streaming text · thinking · tool calls · sentences · latency · tokens</div>
              </div>
            )}
            {past.length > 0 && (
              <>
                <div className="br-past-banner">
                  <span className="br-lbl">earlier in this session</span>
                  <span className="br-past-line" />
                </div>
                {past.map((x, i) => (
                  // styled as a real (static) turn so resumed history matches
                  // the live chat look — same user/reply markup as <Turn>.
                  <div key={`past-${i}`} className="br-turn past">
                    <div className="br-user">
                      <span className="br-caret">❯</span> {x.user}
                      {x.userAt != null && <span className="br-ts mono">{fmtTime(x.userAt)}</span>}
                    </div>
                    {x.reply && (
                      <div className="br-reply">
                        {x.reply}
                        {x.replyAt != null && <span className="br-ts mono">{fmtTime(x.replyAt)}</span>}
                      </div>
                    )}
                  </div>
                ))}
                <div className="br-past-banner">
                  <span className="br-lbl">live</span>
                  <span className="br-past-line" />
                </div>
              </>
            )}
            {turnList.map((t, i) => {
              // divider between resumed (obs-hydrated) history and live turns
              const prevResumed = i > 0 && turnList[i - 1]!.resumed;
              const showLiveDivider = prevResumed && !t.resumed;
              const showHistBanner = i === 0 && t.resumed;
              return (
                <Fragment key={t.turnId}>
                  {showHistBanner && (
                    <div className="br-past-banner"><span className="br-lbl">earlier in this session</span><span className="br-past-line" /></div>
                  )}
                  {showLiveDivider && (
                    <div className="br-past-banner"><span className="br-lbl">live</span><span className="br-past-line" /></div>
                  )}
                  <Turn t={t} sel={sel?.turnId === t.turnId} onSelect={() => setSelected(t.turnId)} />
                </Fragment>
              );
            })}
            {turnList.length > 0 && turnList[turnList.length - 1]!.resumed && (
              <div className="br-past-banner"><span className="br-lbl">live</span><span className="br-past-line" /></div>
            )}
          </div>
          <div className="br-composer">
            <span className={`br-prompt ${turnActive ? 'busy' : ''}`}>{turnActive ? '◌' : '❯'}</span>
            <input
              ref={inputEl}
              placeholder={connected ? (turnActive ? 'turn running…' : 'say something…') : 'offline — connect first'}
              value={input} disabled={!connected}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') cancel(); }}
            />
            {turnActive
              ? <button className="br-btn bad" onClick={cancel}>cancel (esc)</button>
              : <button className="br-btn acc" onClick={send} disabled={!connected || input.trim() === ''}>send ⏎</button>}
          </div>
        </div>

        <div className="br-panel br-inspector">
          {!sel ? (
            <div className="br-empty"><div className="br-empty-glyph">⟢</div><div className="dim">turn inspector</div></div>
          ) : (
            <>
              <div className="br-insp-head">
                <span className="mono br-turnid">{sel.turnId}</span>
                <span className="dim">{sel.model} · think:{sel.thinkingLevel} · {sel.historyMessages} msg history</span>
                {sel.stt && <SttBadge stt={sel.stt} />}
              </div>
              <Timeline turn={sel} />
              <table className="br-steps">
                <thead><tr><th>step</th><th>ttft</th><th>think</th><th>total</th><th>stop / tool</th><th>in</th><th>out</th><th>cost</th></tr></thead>
                <tbody>
                  {sel.steps.map((s) => {
                    const open = expandedStep === s.step;
                    const hasErr = s.stopReason === 'error' || s.tools.some((t) => t.isError);
                    const stopCls = s.stopReason === 'error' ? 'err' : s.stopReason === 'toolUse' ? 'tool' : 'dim';
                    return (
                      <Fragment key={s.step}>
                      <tr className={`br-step-row ${open ? 'open' : ''}`}
                        onClick={() => setExpandedStep(open ? null : s.step)}>
                        <td className="dim">{open ? '▾' : '▸'} {s.step}</td>
                        <td>{fmtMs(s.ttftMs)}</td>
                        <td className={s.thinkingMs ? '' : 'dim'}>{s.thinkingMs != null ? fmtMs(s.thinkingMs) : '—'}</td>
                        <td>{fmtMs(s.ms)}</td>
                        <td>
                          <span className={`br-stop ${stopCls}`}>{s.stopReason ?? '…'}</span>
                          {s.tools.map((t, i) => (
                            <span key={i} className={`br-tool-chip ${t.isError ? 'err' : ''}`}>{t.name}</span>
                          ))}
                        </td>
                        <td>{s.usage?.input ?? ''}</td>
                        <td>{s.usage?.output ?? ''}</td>
                        <td className="dim">{fmtCost(s.usage?.cost)}</td>
                      </tr>
                      {open && (
                        <tr className="br-step-detail-row">
                          <td colSpan={8}>
                            <StepDetail step={s} turnError={hasErr ? sel.error : undefined} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                  {totals && (
                    <tr className="br-totals">
                      <td>Σ</td>
                      <td>{fmtMs(sel.steps[0]?.ttftMs)}</td>
                      <td>{(() => { const th = sel.steps.reduce((a, s) => a + (s.thinkingMs ?? 0), 0); return th > 0 ? fmtMs(th) : '—'; })()}</td>
                      <td>{fmtMs(sel.totalMs)}</td>
                      <td />
                      <td>{totals.input}</td>
                      <td>{totals.output}</td>
                      <td>{fmtCost(totals.cost)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="br-hist">
                <div className="br-lbl" style={{ marginBottom: 4 }}>turns</div>
                {/* (sessions panel rendered after this block) */}
                {turnList.slice().reverse().map((t) => (
                  <div key={t.turnId} className={`br-hist-row ${sel.turnId === t.turnId ? 'sel' : ''}`}
                    onClick={() => setSelected(t.turnId)}>
                    <span className={`br-led tiny ${t.state ?? 'live'}`} />
                    <span className="br-hist-text">{t.text}</span>
                    <span className="mono dim">{fmtMs(t.totalMs)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {sessions.length > 0 && (
            <div className="br-sess">
              <div className="br-lbl" style={{ margin: '10px 0 4px' }}>sessions</div>
              {sessions.slice(0, 8).map((sx) => (
                <div key={sx.sessionId} className="br-sess-row" title={sx.summary ?? ''}>
                  <span className={`br-led tiny ${sx.closedAt == null ? 'on' : 'off'}`} />
                  <span className="mono br-sess-id">{sx.sessionId}</span>
                  <span className="dim">{sx.turns}t · {new Date(sx.openedAt).toLocaleDateString()} {new Date(sx.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="br-sess-sum dim">{sx.summary?.split('\n').at(-1) ?? ''}</span>
                  <span className="spacer" />
                  {sx.closedAt == null
                    ? <span className="br-chip mini">open</span>
                    : <>
                        <button className="br-btn tiny" onClick={() => resumeSession(sx.sessionId)}>continue</button>
                        <button className="br-btn tiny bad" title="delete permanently" onClick={() => deleteSession(sx.sessionId)}>✕</button>
                      </>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* approve/deny a mutating code/file tool (write/edit/run) */}
      {confirm && (
        <div className="br-confirm-overlay" onClick={() => resolveConfirm('deny')}>
          <div className="br-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="br-confirm-title">{confirm.summary}</div>
            {confirm.detail && <pre className="br-confirm-detail">{confirm.detail}</pre>}
            <div className="br-confirm-actions">
              <button className="br-btn" onClick={() => resolveConfirm('deny')}>Deny</button>
              <button className="br-btn" onClick={() => resolveConfirm('all')}>Approve all (session)</button>
              <button className="br-btn acc" onClick={() => resolveConfirm('approve')}>Approve</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

const SKILL_TEMPLATE = `---
name: my-skill
description: What this does and when to use it.
---
# My skill

Step-by-step instructions for the dock to follow.
`;

/** The dock's full brain context — everything about THIS dock in one panel,
 *  EDITABLE in place: config (model/persona/thinking + flag toggles), skills
 *  (install/remove), memory, composition, and the live system prompt. */
function DockContext({ p, onPatchConfig, onInstallSkill, onRemoveSkill }: {
  p: DockProfile;
  onPatchConfig: (partial: Record<string, unknown>) => Promise<void>;
  onInstallSkill: (content: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
  onRemoveSkill: (name: string) => Promise<void>;
}) {
  const grants = Object.entries(p.config.brainGrants ?? {});
  const [model, setModel] = useState(p.config.brainModel);
  const [persona, setPersona] = useState(p.config.brainPersona);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // keep local edit fields in sync when the profile reloads
  useEffect(() => { setModel(p.config.brainModel); setPersona(p.config.brainPersona); }, [p.config.brainModel, p.config.brainPersona]);

  const save = async (partial: Record<string, unknown>) => { setBusy(true); try { await onPatchConfig(partial); } finally { setBusy(false); } };
  const modelDirty = model !== p.config.brainModel;
  const personaDirty = persona !== p.config.brainPersona;

  return (
    <div className="br-ctx">
      <div className="br-ctx-grid">
        {/* composition — who's online in this dock */}
        <div className="br-ctx-card">
          <div className="br-ctx-h">composition</div>
          {p.composition.components.length === 0
            ? <span className="dim">no components seen</span>
            : p.composition.components.map((c) => (
                <div key={c.component} className="br-ctx-comp">
                  <span className={`br-led tiny ${c.online ? 'on' : 'off'}`} />
                  <span className="mono">{c.component}</span>
                  <span className="dim">{c.kind}{c.build != null ? ` ·b${c.build}` : ''}</span>
                  <span className="br-ctx-caps">{(c.caps ?? []).join(' ')}</span>
                </div>
              ))}
        </div>

        {/* profile / config — EDITABLE */}
        <div className="br-ctx-card">
          <div className="br-ctx-h">brain profile</div>
          <div className="br-kv">
            <span className="br-kv-k">model</span>
            <input className="br-ctx-in mono" value={model} onChange={(e) => setModel(e.target.value)} />
            {modelDirty && <button className="br-btn tiny acc" disabled={busy} onClick={() => save({ brainModel: model })}>set</button>}
          </div>
          <div className="br-kv">
            <span className="br-kv-k">thinking</span>
            <div className="br-seg sm">
              {THINKING_LEVELS.map((l) => (
                <button key={l} className={p.config.brainThinkingLevel === l ? 'on' : ''}
                  disabled={busy} onClick={() => save({ brainThinkingLevel: l })}>{l}</button>
              ))}
            </div>
          </div>
          <div className="br-kv">
            <span className="br-kv-k">persona</span>
            <input className="br-ctx-in" placeholder="(stock)" value={persona} onChange={(e) => setPersona(e.target.value)} />
            {personaDirty && <button className="br-btn tiny acc" disabled={busy} onClick={() => save({ brainPersona: persona })}>set</button>}
          </div>
          <KV k="key" v={`${p.key.keyName ?? '—'}${p.key.keySet ? '' : ' (unset!)'}${p.key.alwaysPaid ? ' · paid' : ''}`} />
          <div className="br-ctx-flags">
            <button className={`br-flag ${p.config.brainSkills ? 'on' : ''}`} disabled={busy}
              onClick={() => save({ brainSkills: !p.config.brainSkills })}>skills</button>
            <button className={`br-flag ${p.config.brainFileAccess ? 'danger' : ''}`} disabled={busy}
              onClick={() => { if (p.config.brainFileAccess || window.confirm("Enable code access? This lets the LLM read/modify the station's own code (every write/run is confirmed on the dock).")) save({ brainFileAccess: !p.config.brainFileAccess }); }}>code-access</button>
            <button className={`br-flag ${p.config.brainAlwaysPaid ? 'on' : ''}`} disabled={busy}
              onClick={() => save({ brainAlwaysPaid: !p.config.brainAlwaysPaid })}>always-paid</button>
          </div>
          {grants.length > 0 && (
            <div className="br-ctx-grants">grants: {grants.map(([d, caps]) => `${d}[${caps.join(',')}]`).join('  ')}</div>
          )}
        </div>

        {/* skills — install / remove */}
        <div className="br-ctx-card">
          <div className="br-ctx-h">skills <span className="dim">({p.skills.length})</span></div>
          {p.skills.length === 0
            ? <span className="dim">none installed</span>
            : p.skills.map((s) => (
                <div key={s.name} className="br-ctx-skill">
                  <div className="br-ctx-skill-row">
                    <span className="mono br-ctx-skill-n">{s.name}</span>
                    <button className="br-btn tiny bad" title="remove" disabled={busy} onClick={() => onRemoveSkill(s.name)}>✕</button>
                  </div>
                  <span className="dim">{s.description}</span>
                </div>
              ))}
          <details className="br-ctx-add">
            <summary>+ install a skill</summary>
            <textarea className="br-ctx-skill-ta mono" rows={7} spellCheck={false}
              placeholder={SKILL_TEMPLATE} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
              <button className="br-btn tiny acc" disabled={busy || !draft.trim()}
                onClick={async () => {
                  setBusy(true); setMsg(null);
                  const r = await onInstallSkill(draft);
                  setMsg(r.ok ? { ok: true, text: `installed "${r.name}"` } : { ok: false, text: r.error ?? 'failed' });
                  if (r.ok) setDraft('');
                  setBusy(false);
                }}>install</button>
              {msg && <span className={msg.ok ? 'dim' : 'err'}>{msg.text}</span>}
            </div>
          </details>
        </div>

        {/* memory */}
        <div className="br-ctx-card">
          <div className="br-ctx-h">memory <span className="dim">(seeds new sessions)</span></div>
          {p.memory
            ? <div className="br-ctx-mem">{p.memory}</div>
            : <span className="dim">nothing remembered yet across sessions</span>}
          <div className="dim" style={{ marginTop: 6, fontSize: 10 }}>{p.sessionCount} sessions · {p.openSession ? `open: ${p.openSession}` : 'none open'}</div>
        </div>
      </div>

      {/* the system prompt the brain would actually send */}
      <details className="br-ctx-sys">
        <summary>system prompt <span className="dim">({p.systemPrompt.length} chars — what the brain sends now)</span></summary>
        <pre className="br-ctx-sys-pre">{p.systemPrompt}</pre>
      </details>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="br-kv"><span className="br-kv-k">{k}</span><span className="br-kv-v mono">{v}</span></div>;
}

/** STT confidence for a HEARD turn — Whisper's own metrics, so the inspector shows
 *  WHY a heard transcript was trusted/flagged. Colored by tier (good/shaky/garbage). */
function SttBadge({ stt }: { stt: NonNullable<TurnDebug['stt']> }) {
  const tier = stt.confTier ?? '?';
  const color = tier === 'good' ? '#5fd38d' : tier === 'shaky' ? '#e6c34d' : tier === 'garbage' ? '#e06c6c' : '#888';
  const n = (x: number | null | undefined, d = 2) => (x == null ? '—' : x.toFixed(d));
  return (
    <span className="dim mono" title="Whisper STT confidence — avg_logprob (token certainty), no_speech_prob (P silence/noise), compression_ratio (repetition)">
      {' · '}heard:<span style={{ color, fontWeight: 600 }}>{tier}</span>
      {' '}logprob={n(stt.avgLogprob)} noSpeech={n(stt.noSpeechProb)} comp={n(stt.compressionRatio)}
    </span>
  );
}

/** Expanded detail for one step: timings, each tool (name + args + result or
 *  error), and the step/turn error text. */
/** Provider errors often arrive as a nested JSON blob; pull the human message
 *  + status/code out, else show the raw text. */
function prettyError(raw: string): string {
  try {
    let v: unknown = JSON.parse(raw);
    // unwrap { error: { message: "{...}" } } and stringified inner json
    for (let i = 0; i < 3 && v && typeof v === 'object'; i++) {
      const e = (v as { error?: unknown }).error ?? v;
      const msg = (e as { message?: unknown }).message;
      if (typeof msg === 'string') {
        const trimmed = msg.trim();
        if (trimmed.startsWith('{')) { try { v = JSON.parse(trimmed); continue; } catch { return trimmed; } }
        const code = (e as { code?: unknown }).code ?? (e as { status?: unknown }).status;
        return code != null ? `${code}: ${trimmed}` : trimmed;
      }
      v = e === v ? null : e;
    }
  } catch { /* not json */ }
  return raw;
}

function StepDetail({ step, turnError }: { step: StepDebug; turnError?: string }) {
  const fmtArgs = (a: unknown) => {
    if (a == null) return '';
    try { return typeof a === 'string' ? a : JSON.stringify(a, null, 2); } catch { return String(a); }
  };
  return (
    <div className="br-step-detail">
      <div className="br-sd-meta">
        <span>model <b className="mono">{step.model || '—'}</b></span>
        <span>stop <b className={`mono ${step.stopReason === 'error' ? 'err' : ''}`}>{step.stopReason ?? '—'}</b></span>
        <span>ttft <b className="mono">{fmtMs(step.ttftMs)}</b></span>
        {step.ttftTextMs != null && <span>first-text <b className="mono">{fmtMs(step.ttftTextMs)}</b></span>}
        <span>total <b className="mono">{fmtMs(step.ms)}</b></span>
        {step.usage && <span>tokens <b className="mono">{step.usage.input}→{step.usage.output}</b></span>}
        {step.usage?.cost != null && <span>cost <b className="mono">{fmtCost(step.usage.cost)}</b></span>}
      </div>

      {/* the step's own error (e.g. the 429 body) — shown even when a later
          step recovered the turn, so an errored step says WHAT failed. */}
      {step.error && (
        <div className="br-sd-block">
          <div className="br-sd-k err">error</div>
          <pre className="br-sd-pre err">{prettyError(step.error)}</pre>
        </div>
      )}

      {step.tools.length === 0 && !step.error && !turnError && (
        <div className="br-sd-empty dim">No tools called in this step.</div>
      )}

      {step.tools.map((t, i) => (
        <div key={i} className={`br-sd-tool ${t.isError ? 'err' : ''}`}>
          <div className="br-sd-tool-head">
            <span className={`br-tool-chip ${t.isError ? 'err' : ''}`}>{t.name}</span>
            {t.ms != null && <span className="dim mono">{fmtMs(t.ms)}</span>}
            {t.isError && <span className="br-sd-tag err">error</span>}
          </div>
          {t.args != null && fmtArgs(t.args).length > 0 && (
            <div className="br-sd-block">
              <div className="br-sd-k">args</div>
              <pre className="br-sd-pre">{fmtArgs(t.args)}</pre>
            </div>
          )}
          {t.result != null && String(t.result).length > 0 && (
            <div className="br-sd-block">
              <div className="br-sd-k">{t.isError ? 'error' : 'result'}</div>
              <pre className={`br-sd-pre ${t.isError ? 'err' : ''}`}>{String(t.result)}</pre>
            </div>
          )}
        </div>
      ))}

      {turnError && (
        <div className="br-sd-block">
          <div className="br-sd-k err">turn error</div>
          <pre className="br-sd-pre err">{turnError}</pre>
        </div>
      )}
    </div>
  );
}

function Led({ on, pulse, label }: { on: boolean; pulse: boolean; label: string }) {
  return (
    <span className="br-ledwrap" title={`${label}: ${on ? 'up' : 'down'}`}>
      <span className={`br-led ${on ? 'on' : 'off'} ${pulse ? 'pulse' : ''}`} />
      <span className="br-lbl">{label}</span>
    </span>
  );
}

function Turn({ t, sel, onSelect }: { t: TurnDebug; sel: boolean; onSelect: () => void }) {
  const live = t.state == null;
  return (
    <div className={`br-turn ${t.state ?? 'live'} ${sel ? 'sel' : ''}`} onClick={onSelect}>
      <div className="br-user">
        <span className="br-caret">❯</span> {t.text}
        <span className="br-ts mono">{fmtTime(t.startedAt)}</span>
      </div>
      {t.thinkingText && (
        <details className="br-think">
          <summary>thinking <span className="dim">({t.thinkingText.length} chars)</span></summary>
          <div>{t.thinkingText}</div>
        </details>
      )}
      {t.streamText && (
        <div className="br-reply">
          {t.streamText}{live && <span className="br-cursor">▋</span>}
          {t.speaks[0]?.at != null && <span className="br-ts mono">{fmtTime(t.speaks[0]!.at)}</span>}
        </div>
      )}
      {t.steps.flatMap((s) => s.tools).map((tool, i) => (
        <div key={i} className={`br-tool ${tool.isError ? 'err' : ''}`}>
          <span className="br-tool-ico">⚙</span> {tool.name}
          <span className="br-args">{JSON.stringify(tool.args)}</span>
          {tool.ms != null && <span className="br-chip mini">{fmtMs(tool.ms)}</span>}
          {tool.result && <span className="br-result">→ {tool.result}</span>}
        </div>
      ))}
      {t.speaks.length > 0 && (
        <div className="br-speaks">
          {t.speaks.map((s) => <span key={s.seq} className="br-speak">▸ {s.text}</span>)}
        </div>
      )}
      {t.error && <div className="br-error mono">{t.error}</div>}
      <div className="br-foot">
        <span className={`br-led tiny ${t.state ?? 'live'}`} />
        <span className={`br-state ${t.state ?? 'live'}`}>{t.state ?? 'running'}{t.code ? ` · ${t.code}` : ''}</span>
        <span className="dim mono">{fmtMs(t.totalMs ?? Date.now() - t.startedAt)}</span>
        {t.steps.length > 0 && <span className="dim">{t.steps.length} step{t.steps.length > 1 ? 's' : ''}</span>}
      </div>
    </div>
  );
}

function Timeline({ turn }: { turn: TurnDebug }) {
  const total = Math.max(turn.totalMs ?? Date.now() - turn.startedAt, 1);
  const pct = (at: number) => `${Math.min(((at - turn.startedAt) / total) * 100, 100)}%`;
  const widthPct = (fromMs: number, toMs: number) =>
    `${Math.max(Math.min(((toMs - fromMs) / total) * 100, 100), 0.4)}%`;
  // ms ruler ticks: 4 divisions
  const ticks = [0.25, 0.5, 0.75].map((f) => ({ left: `${f * 100}%`, label: fmtMs(total * f) }));

  return (
    <div className="br-tl">
      <div className="br-tl-bar">
        {ticks.map((tk, i) => <span key={i} className="br-tl-tick" style={{ left: tk.left }} />)}
        {turn.steps.map((s) => {
          const ttftEnd = s.ttftMs != null ? s.startedAt + s.ttftMs : undefined;
          const thinkEnd = ttftEnd != null && s.thinkingMs != null ? ttftEnd + s.thinkingMs : undefined;
          const stepEnd = s.ms != null ? s.startedAt + s.ms : Date.now();
          const streamFrom = thinkEnd ?? ttftEnd ?? s.startedAt;
          return (
            <span key={s.step}>
              {ttftEnd != null && (
                <span className="br-tl-seg wait" title={`step ${s.step} ttft ${fmtMs(s.ttftMs)}`}
                  style={{ left: pct(s.startedAt), width: widthPct(s.startedAt, ttftEnd) }} />
              )}
              {thinkEnd != null && (
                <span className="br-tl-seg think" title={`step ${s.step} thinking ${fmtMs(s.thinkingMs)}`}
                  style={{ left: pct(ttftEnd!), width: widthPct(ttftEnd!, thinkEnd) }} />
              )}
              <span className="br-tl-seg stream" title={`step ${s.step}`}
                style={{ left: pct(streamFrom), width: widthPct(streamFrom, stepEnd) }} />
            </span>
          );
        })}
        {turn.steps.flatMap((s) => s.tools).map((tool, i) => (
          <span key={`t${i}`} className={`br-tl-mark tool ${tool.isError ? 'err' : ''}`}
            title={`${tool.name} ${fmtMs(tool.ms)}`} style={{ left: pct(tool.at) }} />
        ))}
        {turn.speaks.map((s) => (
          <span key={`s${s.seq}`} className="br-tl-mark speak" title={s.text} style={{ left: pct(s.at) }} />
        ))}
      </div>
      <div className="br-tl-legend">
        <span><i className="k wait" />ttft</span>
        <span><i className="k think" />think</span>
        <span><i className="k stream" />stream</span>
        <span><i className="k tool" />tool</span>
        <span><i className="k speak" />sentence</span>
        <span className="spacer" />
        <span className="mono">{fmtMs(turn.totalMs ?? Date.now() - turn.startedAt)}</span>
      </div>
    </div>
  );
}

// ── tasks panel (docs/tasks.md §8) ────────────────────────────────────────

interface TaskParamSpec { name: string; type: string; required?: boolean; default?: unknown }
interface TaskDefDto { name: string; description: string; params: TaskParamSpec[]; goal: string; source?: 'packaged' | 'generated' }
interface TaskInstanceDto {
  instanceId: string; name: string; state: string; params: Record<string, unknown>;
  startedAt: number; lastSignal?: string; status?: string; log?: string;
}

function TasksPanel({ dock }: { dock: string }) {
  const [defs, setDefs] = useState<TaskDefDto[]>([]);
  const [instances, setInstances] = useState<TaskInstanceDto[]>([]);
  const [selDef, setSelDef] = useState<TaskDefDto | null>(null);
  const [selInst, setSelInst] = useState<string | null>(null);
  const [paramText, setParamText] = useState('{}');
  const [detail, setDetail] = useState<TaskInstanceDto | null>(null);
  const [answer, setAnswer] = useState('');
  const [msg, setMsg] = useState('');

  const loadDefs = useCallback(async () => {
    const r = await fetch('/api/brain/tasks'); if (r.ok) setDefs(await r.json());
  }, []);
  const loadInstances = useCallback(async () => {
    const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/instances`);
    if (r.ok) setInstances(await r.json());
  }, [dock]);
  const loadDetail = useCallback(async (id: string) => {
    const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/instances/${encodeURIComponent(id)}`);
    if (r.ok) setDetail(await r.json());
  }, [dock]);

  useEffect(() => { void loadDefs(); }, [loadDefs]);
  useEffect(() => {
    void loadInstances();
    const t = setInterval(() => { void loadInstances(); if (selInst) void loadDetail(selInst); }, 1500);
    return () => clearInterval(t);
  }, [loadInstances, loadDetail, selInst]);

  const run = async () => {
    setMsg('');
    let params: unknown; try { params = JSON.parse(paramText || '{}'); } catch { setMsg('params: invalid JSON'); return; }
    const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/instances`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: selDef!.name, params }),
    });
    const body = await r.json().catch(() => ({}));
    setMsg(r.ok ? `started ${body.instanceId}` : `error: ${body.error ?? r.status}`);
    await loadInstances();
  };
  const op = async (id: string, action: string) => {
    await fetch(`/api/brain/${encodeURIComponent(dock)}/instances/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    await loadInstances(); if (selInst === id) await loadDetail(id);
  };
  const sendInput = async (id: string) => {
    await fetch(`/api/brain/${encodeURIComponent(dock)}/instances/${encodeURIComponent(id)}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }),
    });
    setAnswer(''); await loadInstances(); await loadDetail(id);
  };

  const openDef = (d: TaskDefDto) => {
    setSelDef(d);
    const seed: Record<string, unknown> = {};
    for (const p of d.params) if (p.default !== undefined) seed[p.name] = p.default;
    setParamText(JSON.stringify(seed, null, 2));
  };

  return (
    <div className="tk-wrap">
      <style>{TASK_CSS}</style>
      <div className="tk-cols">
        {/* definitions */}
        <div className="tk-col">
          <div className="tk-h">DEFINITIONS <span className="dim">· packaged + generated</span></div>
          {defs.map((d) => (
            <div key={d.name} className={`tk-row ${selDef?.name === d.name ? 'sel' : ''}`} onClick={() => openDef(d)}>
              <span className={`tk-src src-${d.source ?? 'packaged'}`}>{(d.source ?? 'packaged') === 'generated' ? 'gen' : 'pkg'}</span>
              <span className="tk-name">{d.name}</span>
              <span className="tk-desc dim">{d.description}</span>
            </div>
          ))}
          {selDef && (
            <div className="tk-detail">
              <div className="tk-goal">{selDef.goal}</div>
              <label className="br-lbl">params (json)</label>
              <textarea className="tk-params mono" value={paramText} onChange={(e) => setParamText(e.target.value)} rows={Math.max(3, selDef.params.length + 1)} />
              <div className="tk-actions">
                <button className="br-btn acc" onClick={run}>▶ run on {dock}</button>
                {msg && <span className="dim mono">{msg}</span>}
              </div>
            </div>
          )}
        </div>

        {/* instances */}
        <div className="tk-col">
          <div className="tk-h">RUNNING <span className="dim">· this dock</span></div>
          {instances.length === 0 && <div className="dim" style={{ padding: '6px 8px' }}>no tasks running</div>}
          {instances.map((i) => (
            <div key={i.instanceId} className={`tk-row ${selInst === i.instanceId ? 'sel' : ''}`}
              onClick={() => { setSelInst(i.instanceId); void loadDetail(i.instanceId); }}>
              <span className={`tk-badge st-${i.state}`}>{i.state}</span>
              <span className="tk-name mono">{i.instanceId}</span>
              <span className="tk-desc dim">{i.name}</span>
            </div>
          ))}
          {detail && selInst && (
            <div className="tk-detail">
              <div className="tk-status mono">{detail.status || '(no status yet)'}</div>
              {detail.state === 'stuck' && (
                <div className="tk-stuck">
                  <div className="tk-stuck-q">{detail.lastSignal}</div>
                  <div className="tk-actions">
                    <input className="br-in" value={answer} placeholder="your answer…" onChange={(e) => setAnswer(e.target.value)} />
                    <button className="br-btn acc" onClick={() => sendInput(selInst)}>answer</button>
                  </div>
                </div>
              )}
              <div className="tk-actions">
                <button className="br-btn" onClick={() => op(selInst, 'pause')}>pause</button>
                <button className="br-btn" onClick={() => op(selInst, 'resume')}>resume</button>
                <button className="br-btn" onClick={() => op(selInst, 'restart')}>restart</button>
                <button className="br-btn" onClick={() => op(selInst, 'stop')}>stop</button>
              </div>
              <label className="br-lbl">log</label>
              <pre className="tk-log mono">{detail.log || ''}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const TASK_CSS = `
.tk-wrap { background: #0a0e1a; border: 1px solid #1b2436; border-radius: 8px; padding: 8px; }
.tk-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tk-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tk-h { font-size: 11px; letter-spacing: .08em; color: #6b7a99; padding: 2px 4px 6px; }
.tk-row { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; border-radius: 5px; cursor: pointer; }
.tk-row:hover { background: #121a2c; }
.tk-row.sel { background: #16203a; outline: 1px solid #2a3a5e; }
.tk-name { color: #cdd9f0; font-weight: 600; }
.tk-src { font-size: 9px; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: .04em; flex-shrink: 0; }
.src-packaged { background: #16263a; color: #6f9fe3; }
.src-generated { background: #2a1f3a; color: #b98fe3; }
.tk-desc { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-detail { margin: 6px 4px; padding: 8px; background: #0c1322; border: 1px solid #1b2436; border-radius: 6px; display: flex; flex-direction: column; gap: 6px; }
.tk-goal { font-size: 12px; color: #9fb0d0; white-space: pre-wrap; max-height: 120px; overflow: auto; }
.tk-params { background: #060912; color: #cdd9f0; border: 1px solid #243049; border-radius: 5px; padding: 6px; resize: vertical; }
.tk-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tk-status { font-size: 13px; color: #bfe9c8; }
.tk-log { background: #060912; color: #7e8db0; font-size: 11px; max-height: 160px; overflow: auto; padding: 6px; border-radius: 5px; margin: 0; white-space: pre-wrap; }
.tk-stuck { background: #1c1607; border: 1px solid #4a3a12; border-radius: 6px; padding: 6px; }
.tk-stuck-q { color: #e6c976; font-size: 13px; margin-bottom: 4px; }
.tk-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: .04em; }
.st-running { background: #0f3a24; color: #5fe39a; }
.st-paused { background: #3a300f; color: #e3c95f; }
.st-stuck { background: #3a1f0f; color: #e3955f; }
.st-done { background: #16263a; color: #6f9fe3; }
.st-errored { background: #3a1018; color: #e36f8a; }
.st-stopped { background: #20242e; color: #8a93a5; }
`;

// ── styles ───────────────────────────────────────────────────────────────────

const CSS = `
.brain { display: flex; flex-direction: column; gap: 10px; height: calc(100vh - 32px); }
.brain .mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
.brain .dim { color: var(--dim); }
.brain .spacer { flex: 1; }

/* strips */
.brain .br-strip { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: linear-gradient(180deg, var(--panel-2), var(--panel)); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 8px 12px; }
.brain .br-logo { font-weight: 700; letter-spacing: .18em; font-size: 12px; color: var(--accent);
  text-shadow: 0 0 14px rgba(93,184,255,.45); }
.brain .br-sep { width: 1px; height: 18px; background: var(--line); }
.brain .br-lbl { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: .14em; }
.brain .br-key { display: inline-flex; align-items: center; gap: 7px; }
.brain .br-key-name { display: inline-flex; align-items: center; gap: 5px; font-family: ui-monospace, Menlo, monospace;
  font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); }
.brain .br-key-name.ok { color: var(--fg); }
.brain .br-key-name.bad { color: #ff6b6b; border-color: rgba(255,107,107,.4); }
.brain .br-key-name.dim { color: var(--dim); }
.brain .br-key-dot { width: 7px; height: 7px; border-radius: 50%; background: #3ad29f; box-shadow: 0 0 6px rgba(58,210,159,.6); }
.brain .br-key-name.bad .br-key-dot { background: #ff6b6b; box-shadow: 0 0 6px rgba(255,107,107,.6); }
.brain .br-key-tag { font-size: 8px; text-transform: uppercase; letter-spacing: .1em; padding: 1px 5px; border-radius: 4px;
  background: rgba(255,196,84,.18); color: #ffc454; border: 1px solid rgba(255,196,84,.35); }
.brain .br-key-fallback { font-size: 10px; color: var(--dim); font-family: ui-monospace, Menlo, monospace; }
.brain .br-key-fallback.bad { color: #ff9b6b; }
/* 2c perception test surface */
.brain .br-percept .br-logo { color: var(--accent-2, #7ec699); text-shadow: 0 0 14px rgba(126,198,153,.35); }
.brain .br-state { font-size: 11px; font-family: ui-monospace, Menlo, monospace; padding: 3px 9px; border-radius: 6px;
  border: 1px solid var(--line); text-transform: lowercase; letter-spacing: .04em; }
.brain .br-state-idle { color: var(--dim); }
.brain .br-state-listening { color: #ffc454; border-color: rgba(255,196,84,.45); background: rgba(255,196,84,.1); }
.brain .br-state-speaking { color: #5db8ff; border-color: rgba(93,184,255,.45); background: rgba(93,184,255,.1); }
.brain .br-state-thinking { color: #7ec699; border-color: rgba(126,198,153,.45); background: rgba(126,198,153,.1); }
.brain .br-grounding { margin: 0 0 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: rgba(10,14,26,.55); color: var(--fg); font-family: ui-monospace, Menlo, monospace; font-size: 11px;
  white-space: pre-wrap; max-height: 220px; overflow: auto; }
/* 4c memory inspector */
.brain .br-mem { margin: 0 0 10px; border: 1px solid var(--line); border-radius: 8px; background: rgba(10,14,26,.4); overflow: hidden; }
.brain .br-mem-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brain .br-mem-count { font-size: 11px; color: var(--accent-2, #7ec699); font-weight: 600; }
.brain .br-mem-subjects { font-size: 10px; color: var(--dim); }
.brain .br-mem-body { display: flex; gap: 0; max-height: 280px; }
.brain .br-mem-list { flex: 1; overflow: auto; }
.brain .br-mem-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.04); font-size: 12px; }
.brain .br-mem-row:hover { background: rgba(255,255,255,.03); }
.brain .br-mem-row.sel { background: rgba(93,184,255,.1); }
.brain .br-mem-type { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--dim); flex-shrink: 0; }
.brain .br-mem-type.t-person { color: #7ec699; border-color: rgba(126,198,153,.4); }
.brain .br-mem-type.t-preference { color: #ffc454; border-color: rgba(255,196,84,.4); }
.brain .br-mem-type.t-summary { color: #5db8ff; border-color: rgba(93,184,255,.4); }
.brain .br-mem-subj { font-size: 11px; color: var(--accent-2, #7ec699); flex-shrink: 0; }
.brain .br-mem-claim { flex: 1; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brain .br-mem-conf { font-size: 10px; color: var(--dim); font-family: ui-monospace, Menlo, monospace; flex-shrink: 0; }
.brain .br-mem-detail { width: 280px; flex-shrink: 0; padding: 10px 12px; border-left: 1px solid var(--line); background: var(--bg-1); overflow: auto; }
.brain .br-mem-detail-h { font-size: 9px; text-transform: uppercase; letter-spacing: .14em; color: var(--accent); margin-bottom: 6px; }
.brain .br-mem-claim-lg { font-size: 12px; color: var(--fg); margin-bottom: 8px; }
.brain .br-mem-lin { font-size: 11px; color: var(--accent-2, #7ec699); margin: 2px 0; }
/* 5c proactive gate */
.brain .br-gate { margin: 0 0 10px; border: 1px solid var(--line); border-radius: 8px; background: rgba(10,14,26,.4); overflow: hidden; }
.brain .br-gate-bar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brain .br-gate-log { max-height: 200px; overflow: auto; }
.brain .br-gate-row { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,.04); font-size: 11px; }
.brain .br-gate-row.raised { background: rgba(126,198,153,.07); }
.brain .br-gate-time { color: var(--dim); flex-shrink: 0; }
.brain .br-gate-verb { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--dim); flex-shrink: 0; }
.brain .br-gate-verb.on { color: #7ec699; border-color: rgba(126,198,153,.45); background: rgba(126,198,153,.1); }
.brain .br-gate-detail { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* dock context panel */
.brain .br-ctx { margin: 0 0 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(10,14,26,.4); }
.brain .br-ctx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.brain .br-ctx-card { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-1); }
.brain .br-ctx-h { font-size: 9px; text-transform: uppercase; letter-spacing: .14em; color: var(--accent); margin-bottom: 8px; }
.brain .br-ctx-comp { display: flex; align-items: center; gap: 7px; font-size: 11px; margin: 3px 0; }
.brain .br-ctx-caps { color: var(--accent-2); font-size: 10px; font-family: ui-monospace, Menlo, monospace; margin-left: auto; }
.brain .br-kv { display: flex; gap: 8px; font-size: 11px; margin: 2px 0; }
.brain .br-kv-k { color: var(--dim); min-width: 56px; }
.brain .br-kv-v { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brain .br-ctx-flags { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
.brain .br-flag { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; padding: 2px 7px; border-radius: 5px;
  border: 1px solid var(--line); color: var(--dim); }
.brain .br-flag.on { color: var(--good); border-color: rgba(74,214,160,.4); background: rgba(74,214,160,.08); }
.brain .br-flag.danger { color: var(--bad); border-color: rgba(255,107,129,.45); background: rgba(255,107,129,.1); }
.brain .br-ctx-grants { margin-top: 8px; font-size: 10px; color: var(--accent-2); font-family: ui-monospace, Menlo, monospace; }
.brain .br-ctx-skill { font-size: 11px; margin: 4px 0; display: flex; flex-direction: column; }
.brain .br-ctx-skill-row { display: flex; align-items: center; gap: 6px; }
.brain .br-ctx-skill-n { color: var(--accent-2); flex: 1; }
.brain .br-ctx-in { flex: 1; min-width: 0; background: var(--bg-2); border: 1px solid var(--line); color: var(--fg);
  border-radius: 5px; padding: 3px 7px; font-size: 11px; outline: none; }
.brain .br-ctx-in:focus { border-color: var(--accent); }
.brain .br-seg.sm button { font-size: 9px; padding: 2px 6px; }
.brain .br-ctx-add { margin-top: 8px; }
.brain .br-ctx-add summary { cursor: pointer; font-size: 10px; color: var(--accent); }
.brain .br-ctx-skill-ta { width: 100%; margin-top: 6px; background: var(--bg-2); border: 1px solid var(--line);
  color: var(--fg); border-radius: 6px; padding: 7px; font-size: 11px; outline: none; resize: vertical; }
.brain .br-btn.tiny.bad { color: var(--bad); border-color: rgba(255,107,129,.35); }
.brain .br-flag { cursor: pointer; background: none; }
.brain .br-flag:disabled { opacity: .5; cursor: default; }
.brain .br-ctx-mem { font-size: 11px; color: var(--fg); line-height: 1.5; white-space: pre-wrap; }
.brain .br-ctx-sys { margin-top: 10px; }
.brain .br-ctx-sys summary { cursor: pointer; font-size: 11px; color: var(--accent); }
.brain .br-ctx-sys-pre { margin: 8px 0 0; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px;
  font-size: 11px; color: var(--fg); white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto;
  font-family: ui-monospace, Menlo, monospace; line-height: 1.5; }
.brain .br-confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex;
  align-items: center; justify-content: center; z-index: 100; }
.brain .br-confirm { background: var(--bg-1); border: 1px solid var(--accent); border-radius: 12px;
  padding: 20px; max-width: 560px; width: 90%; box-shadow: 0 12px 48px rgba(0,0,0,.5); }
.brain .br-confirm-title { font-size: 15px; font-weight: 600; color: var(--fg); margin-bottom: 12px; }
.brain .br-confirm-detail { background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; font-size: 12px; color: var(--fg); white-space: pre-wrap; word-break: break-word;
  max-height: 280px; overflow: auto; margin: 0 0 16px; font-family: ui-monospace, Menlo, monospace; }
.brain .br-confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }
.brain .br-in { background: var(--bg-2); border: 1px solid var(--line); color: var(--fg);
  border-radius: 6px; padding: 5px 9px; font-size: 12px; outline: none; }
.brain .br-in:focus { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(93,184,255,.25); }
.brain .br-dock { width: 110px; font-family: ui-monospace, Menlo, monospace; }
.brain .br-model { flex: 1; min-width: 200px; font-size: 11px; }
.brain .br-num { width: 80px; }
.brain select.br-in { max-width: 230px; }

/* buttons */
.brain .br-btn { background: var(--bg-2); border: 1px solid var(--line); color: var(--dim);
  border-radius: 6px; padding: 5px 13px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .1em; cursor: pointer; transition: all .15s; }
.brain .br-btn:hover:not(:disabled) { color: var(--fg); border-color: var(--accent); }
.brain .br-btn:disabled { opacity: .35; cursor: default; }
.brain .br-btn.acc { color: var(--accent); border-color: rgba(93,184,255,.4); }
.brain .br-btn.acc:hover:not(:disabled) { box-shadow: var(--glow); }
.brain .br-btn.glow { box-shadow: var(--glow); }
.brain .br-btn.bad { color: var(--bad); border-color: rgba(255,107,129,.4); }

/* segmented control */
.brain .br-seg { display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.brain .br-seg button { background: var(--bg-2); border: none; color: var(--dim); font-size: 10px;
  padding: 5px 9px; cursor: pointer; text-transform: uppercase; letter-spacing: .06em; }
.brain .br-seg button + button { border-left: 1px solid var(--line); }
.brain .br-seg button.on { background: rgba(93,184,255,.15); color: var(--accent); }

/* LEDs */
.brain .br-ledwrap { display: inline-flex; align-items: center; gap: 5px; }
.brain .br-led { width: 8px; height: 8px; border-radius: 50%; background: #2a3450; display: inline-block; flex: none; }
.brain .br-led.on, .brain .br-led.done { background: var(--good); box-shadow: 0 0 8px rgba(74,214,160,.6); }
.brain .br-led.off { background: #2a3450; }
.brain .br-led.live { background: var(--accent); box-shadow: 0 0 8px rgba(93,184,255,.6); animation: br-pulse 1.2s infinite; }
.brain .br-led.failed { background: var(--bad); box-shadow: 0 0 8px rgba(255,107,129,.6); }
.brain .br-led.cancelled { background: var(--warn); }
.brain .br-led.pulse { animation: br-pulse 1.2s infinite; }
.brain .br-led.tiny { width: 6px; height: 6px; }
@keyframes br-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

.brain .br-chip { font-size: 10px; padding: 3px 9px; border-radius: 20px; border: 1px solid var(--line);
  background: var(--bg-2); color: var(--fg); }
.brain .br-chip.mini { padding: 1px 7px; color: var(--good); border-color: rgba(74,214,160,.3); margin-left: 7px; }

/* grid */
.brain .br-grid { display: grid; grid-template-columns: minmax(420px, 5fr) minmax(300px, 3fr);
  gap: 10px; flex: 1; min-height: 0; }
@media (max-width: 1000px) { .brain .br-grid { grid-template-columns: 1fr; } }
.brain .br-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

/* transcript */
.brain .br-chat { min-height: 0; }
.brain .br-scroll { flex: 1; overflow-y: auto; padding: 6px 14px; }
.brain .br-empty { height: 100%; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 6px; color: var(--dim); font-size: 12px; }
.brain .br-empty-glyph { font-size: 42px; opacity: .25; text-shadow: 0 0 24px rgba(93,184,255,.5); }
.brain .br-turn { padding: 12px 10px 8px; margin: 6px 0; border-left: 2px solid var(--line);
  border-radius: 4px; cursor: pointer; transition: background .15s, border-color .15s; }
.brain .br-turn:hover { background: rgba(255,255,255,.015); }
.brain .br-turn.sel { background: rgba(93,184,255,.045); }
.brain .br-turn.live { border-left-color: var(--accent); }
.brain .br-turn.done { border-left-color: rgba(74,214,160,.5); }
.brain .br-turn.failed { border-left-color: rgba(255,107,129,.6); }
.brain .br-turn.cancelled { border-left-color: rgba(255,200,97,.6); }
.brain .br-user { font-family: ui-monospace, Menlo, monospace; font-size: 13px; color: var(--accent); }
.brain .br-caret { opacity: .6; }
.brain .br-reply { margin: 8px 0 2px 14px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; }
.brain .br-ts { float: right; font-size: 10.5px; color: #5a6b8c; opacity: .7; font-weight: 400; margin-left: 8px; }
.brain .br-ts:hover { opacity: 1; }
.brain .br-cursor { color: var(--accent); animation: br-pulse .9s infinite; margin-left: 1px; }
.brain .br-think { margin: 6px 0 0 14px; font-size: 11px; color: var(--dim); }
.brain .br-think summary { cursor: pointer; letter-spacing: .04em; }
.brain .br-think div { white-space: pre-wrap; font-style: italic; border-left: 1px solid var(--line);
  padding: 6px 10px; margin-top: 4px; max-height: 150px; overflow-y: auto; }
.brain .br-tool { margin: 6px 0 0 14px; font-size: 11px; font-family: ui-monospace, Menlo, monospace;
  color: var(--accent-2); }
.brain .br-tool.err { color: var(--bad); }
.brain .br-tool-ico { opacity: .7; }
.brain .br-args { color: var(--dim); margin-left: 6px; }
.brain .br-result { color: var(--dim); margin-left: 6px; }
.brain .br-speaks { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 0 14px; }
.brain .br-speak { font-size: 11px; padding: 3px 10px; border-radius: 12px; color: var(--good);
  background: rgba(74,214,160,.07); border: 1px solid rgba(74,214,160,.22); }
.brain .br-error { margin: 8px 0 0 14px; font-size: 11px; color: var(--bad);
  background: rgba(255,107,129,.06); border: 1px solid rgba(255,107,129,.25);
  border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; }
.brain .br-foot { display: flex; align-items: center; gap: 8px; margin: 9px 0 0 14px; font-size: 10px; }
.brain .br-state { text-transform: uppercase; letter-spacing: .12em; }
.brain .br-state.live { color: var(--accent); } .brain .br-state.done { color: var(--good); }
.brain .br-state.failed { color: var(--bad); } .brain .br-state.cancelled { color: var(--warn); }

/* composer */
.brain .br-composer { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border-top: 1px solid var(--line); background: var(--bg-2); }
.brain .br-prompt { color: var(--accent); font-family: ui-monospace, Menlo, monospace; font-size: 15px; }
.brain .br-prompt.busy { animation: br-spin 1s linear infinite; display: inline-block; }
@keyframes br-spin { to { transform: rotate(360deg); } }
.brain .br-composer input { flex: 1; background: none; border: none; outline: none; color: var(--fg);
  font-size: 13.5px; font-family: ui-monospace, Menlo, monospace; }
.brain .br-composer input::placeholder { color: var(--dim); opacity: .6; }

/* inspector */
.brain .br-inspector { padding: 12px 14px; gap: 12px; overflow-y: auto; }
.brain .br-insp-head { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
.brain .br-turnid { color: var(--accent); font-size: 12px; }
.brain .br-tl-bar { position: relative; height: 22px; background: var(--bg-2); border: 1px solid var(--line);
  border-radius: 5px; overflow: hidden; }
.brain .br-tl-tick { position: absolute; top: 0; height: 100%; width: 1px; background: var(--line); opacity: .6; }
.brain .br-tl-seg { position: absolute; top: 0; height: 100%; }
.brain .br-tl-seg.wait { background: repeating-linear-gradient(45deg, rgba(255,200,97,.22), rgba(255,200,97,.22) 4px, rgba(255,200,97,.1) 4px, rgba(255,200,97,.1) 8px); }
.brain .br-tl-seg.stream { background: linear-gradient(180deg, rgba(93,184,255,.5), rgba(93,184,255,.3)); }
.brain .br-tl-seg.think { background: repeating-linear-gradient(45deg, rgba(143,123,255,.35), rgba(143,123,255,.35) 4px, rgba(143,123,255,.15) 4px, rgba(143,123,255,.15) 8px); }
.brain .br-tl-mark { position: absolute; top: 3px; width: 3px; height: 16px; border-radius: 2px; }
.brain .br-tl-mark.tool { background: var(--accent-2); box-shadow: 0 0 6px rgba(143,123,255,.7); }
.brain .br-tl-mark.tool.err { background: var(--bad); }
.brain .br-tl-mark.speak { background: var(--good); box-shadow: 0 0 6px rgba(74,214,160,.7); }
.brain .br-tl-legend { display: flex; gap: 12px; align-items: center; font-size: 9px; color: var(--dim);
  text-transform: uppercase; letter-spacing: .1em; margin-top: 5px; }
.brain .br-tl-legend .k { display: inline-block; width: 9px; height: 7px; border-radius: 2px; margin-right: 4px; }
.brain .br-tl-legend .k.wait { background: rgba(255,200,97,.4); } .brain .br-tl-legend .k.stream { background: rgba(93,184,255,.55); }
.brain .br-tl-legend .k.think { background: rgba(143,123,255,.5); }
.brain .br-tl-legend .k.tool { background: var(--accent-2); } .brain .br-tl-legend .k.speak { background: var(--good); }
.brain .br-steps { width: 100%; font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; border-collapse: collapse; }
.brain .br-steps th { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: .12em;
  text-align: left; padding: 3px 8px 5px 0; border-bottom: 1px solid var(--line); font-weight: 500; }
.brain .br-steps td { padding: 4px 8px 4px 0; border-bottom: 1px solid rgba(30,39,64,.5); }
.brain .br-totals td { border-top: 1px solid var(--line); border-bottom: none; color: var(--accent); }
/* clickable / expandable step rows */
.brain .br-step-row { cursor: pointer; }
.brain .br-step-row:hover { background: rgba(93,184,255,.06); }
.brain .br-step-row.open { background: rgba(93,184,255,.09); }
.brain .br-stop { }
.brain .br-stop.err { color: var(--bad); font-weight: 600; }
.brain .br-stop.tool { color: var(--accent-2); }
.brain .br-stop.dim { color: var(--dim); }
.brain .br-tool-chip { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 10px;
  font-size: 10px; background: rgba(143,123,255,.16); color: var(--accent-2); border: 1px solid rgba(143,123,255,.35); }
.brain .br-tool-chip.err { background: rgba(255,107,129,.16); color: var(--bad); border-color: rgba(255,107,129,.4); }
/* step detail panel */
.brain .br-step-detail-row td { border-bottom: 1px solid rgba(30,39,64,.5); padding: 0; }
.brain .br-step-detail { padding: 10px 12px 12px; background: rgba(10,14,26,.5); border-left: 2px solid var(--accent-2); }
.brain .br-sd-meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 10px; color: var(--dim); margin-bottom: 8px; }
.brain .br-sd-meta b { color: var(--fg); font-weight: 500; }
.brain .br-sd-meta b.err { color: var(--bad); }
.brain .br-sd-empty { font-size: 11px; }
.brain .br-sd-tool { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(143,123,255,.06);
  border: 1px solid rgba(143,123,255,.22); }
.brain .br-sd-tool.err { background: rgba(255,107,129,.06); border-color: rgba(255,107,129,.3); }
.brain .br-sd-tool-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.brain .br-sd-tag { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; padding: 1px 5px; border-radius: 4px; }
.brain .br-sd-tag.err { background: rgba(255,107,129,.18); color: var(--bad); }
.brain .br-sd-block { margin-top: 6px; }
.brain .br-sd-k { font-size: 9px; text-transform: uppercase; letter-spacing: .12em; color: var(--dim); margin-bottom: 3px; }
.brain .br-sd-k.err { color: var(--bad); }
.brain .br-sd-pre { margin: 0; padding: 7px 9px; background: var(--bg-2); border: 1px solid var(--line);
  border-radius: 6px; font-size: 11px; color: var(--fg); white-space: pre-wrap; word-break: break-word;
  max-height: 220px; overflow: auto; font-family: ui-monospace, Menlo, monospace; }
.brain .br-sd-pre.err { color: var(--bad); border-color: rgba(255,107,129,.35); }
.brain .br-hist { display: flex; flex-direction: column; gap: 1px; }
.brain .br-hist-row { display: flex; gap: 8px; align-items: center; font-size: 11px; padding: 4px 6px;
  border-radius: 5px; cursor: pointer; }
.brain .br-hist-row.sel, .brain .br-hist-row:hover { background: rgba(93,184,255,.07); }
.brain .br-hist-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* resumed history: real turn markup, slightly muted + not clickable */
.brain .br-turn.past { cursor: default; opacity: .72; border-left-color: rgba(74,214,160,.35); }
.brain .br-turn.past:hover { background: none; }
.brain .br-past-banner { display: flex; align-items: center; gap: 10px; margin: 8px 2px 2px; }
.brain .br-past-banner .br-past-line { flex: 1; height: 1px; background: var(--line); }
.brain .br-sess { border-top: 1px solid var(--line); margin-top: 10px; }
.brain .br-sess-row { display: flex; gap: 8px; align-items: center; font-size: 11px; padding: 4px 6px; border-radius: 5px; }
.brain .br-sess-row:hover { background: rgba(93,184,255,.05); }
.brain .br-sess-id { color: var(--accent); font-size: 10px; }
.brain .br-sess-sum { max-width: 28%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brain .br-btn.tiny { padding: 2px 9px; font-size: 9px; }
`;
