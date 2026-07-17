/**
 * Turn REPLAY — re-execute a recorded turn with NO LLM calls.
 *
 * The recorded assistant responses (raw text + tool calls) are fed back
 * step-by-step through a scripted pi StreamFn, while everything else — the
 * system-prompt build, sentence streaming, speak frames, speech-gate, inline
 * [face:]/[move] tags, tool dispatch, motion — runs the CURRENT live code
 * path on the dock's live session. Logic changes since the recording reflect
 * in the replay; a great turn can be re-performed on the real dock.
 *
 * Sources: the brain SessionStore transcript (raw assistant text — obs strips
 * [face:]/[move] tags from StepRecord.text, so the transcript is the only
 * faithful text source) JOINED with the obs TurnRecord (turn location +
 * step/tool timings for pacing). Obs-only fallback when the transcript slice
 * can't be located (degraded: tags lost).
 *
 * Tool policy: embodiment tools run REAL (that is the point of the replay);
 * everything with an external effect is STUBBED with its recorded result.
 * Tool CALLS are canned (they come from the scripted assistant message,
 * reusing recorded toolCallIds) — only tool EXECUTION is live.
 */

import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import type { StepRecord, TurnRecord } from '../observability/types.js';

/** One recorded LLM step to feed back: what the model "answered". */
export interface ReplayStep {
  /** RAW assistant text, [face:]/[move] tags intact. */
  text: string;
  toolCalls: ToolCall[];
  /** pacing (from the obs StepRecord): delay before the FIRST token (the
   *  original model's latency incl. thinking — the trace's WaitForToken). */
  ttftMs?: number;
  /** pacing: delay before the first TEXT token (≥ ttftMs when it thought). */
  ttftTextMs?: number;
  /** pacing: the TEXT stream window only — first text token → end of text
   *  (tool execution time is EXCLUDED: tools re-run live and pace themselves;
   *  including it would sleep the tool duration twice). */
  streamMs?: number;
}

export interface ReplayScript {
  steps: ReplayStep[];
  /** recorded tool results by toolCallId — what stubbed tools return. */
  results: Record<string, { result: string; isError?: boolean; ms?: number }>;
  /** where the recording came from (provenance in the obs trace). */
  src: { sessionId: string; turnId: string };
  triggerText: string;
  /** reproduce recorded TTFT/stream/tool timings (default) vs run instantly. */
  paced: boolean;
  /** true = built from the obs record only (transcript slice not found):
   *  [face:]/[move] tags were stripped from the recorded text. */
  degraded?: boolean;
}

/** Tools that RUN FOR REAL during a replay — the dock's embodiment, i.e. the
 *  speak/move/face sequencing under test. `move_<target>` grants included. */
const REAL_TOOLS = new Set(['move', 'set_face', 'set_face_style', 'set_zoom']);
const isEmbodiment = (name: string) => REAL_TOOLS.has(name) || name.startsWith('move_');

/** Synthetic obs rows that are NOT LLM tool calls (an inline [face:] tag going
 *  live on the phone rides ToolExecution events) — never canned back as calls,
 *  never part of the text-window timing math. */
const isSyntheticTag = (name: string) => name === 'inline_mood';

/** Ceilings on reproduced delays, so a corrupt record can't wedge a turn. */
const MAX_TTFT_MS = 20_000;
const MAX_STREAM_MS = 60_000;
const MAX_TOOL_MS = 30_000;

// ── script construction ──────────────────────────────────────────────────────

const textOf = (content: string | Array<{ type?: string; text?: string }>): string =>
  typeof content === 'string'
    ? content
    : content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

/** Locate the recorded turn's slice of the session transcript: the user message
 *  whose timestamp falls inside the turn's window (tiebreak: exact trigger-text
 *  match), then everything up to the next user message. */
function transcriptSlice(turn: TurnRecord, messages: AgentMessage[]): AgentMessage[] | undefined {
  const from = turn.startedAt - 2_000;
  const to = (turn.endedAt ?? turn.startedAt + 10 * 60_000) + 2_000;
  const users = messages
    .map((m, i) => ({ m: m as unknown as { role?: string; content?: string | Array<{ type?: string; text?: string }>; timestamp?: number }, i }))
    .filter(({ m }) => m.role === 'user'
      && typeof m.timestamp === 'number' && m.timestamp >= from && m.timestamp <= to);
  if (users.length === 0) return undefined;
  const exact = users.find(({ m }) => textOf(m.content ?? '') === (turn.trigger?.text ?? ''));
  const start = (exact ?? users[0]!).i;
  let end = messages.length;
  for (let i = start + 1; i < messages.length; i++) {
    if ((messages[i] as { role?: string }).role === 'user') { end = i; break; }
  }
  return messages.slice(start + 1, end);
}

function stepTimings(rec: StepRecord | undefined): Pick<ReplayStep, 'ttftMs' | 'ttftTextMs' | 'streamMs'> {
  if (!rec) return {};
  const clampTtft = (v: number) => Math.min(Math.max(v, 0), MAX_TTFT_MS);
  const ttftText = rec.ttftTextMs ?? rec.ttftMs;
  // text ends where the step's REAL tools begin (they execute after the
  // message; synthetic tag rows fire at TTS playback — irrelevant here);
  // a step with no tools streams text until the step end.
  const realTools = rec.tools.filter((t) => !isSyntheticTag(t.toolName));
  const textEnd = realTools.length > 0
    ? Math.min(...realTools.map((t) => t.startedAt))
    : rec.endedAt ?? (rec.ms != null ? rec.startedAt + rec.ms : undefined);
  const stream = textEnd != null && ttftText != null ? textEnd - rec.startedAt - ttftText : undefined;
  return {
    ...(rec.ttftMs != null ? { ttftMs: clampTtft(rec.ttftMs) } : {}),
    ...(ttftText != null ? { ttftTextMs: clampTtft(ttftText) } : {}),
    ...(stream != null && stream > 0 ? { streamMs: Math.min(stream, MAX_STREAM_MS) } : {}),
  };
}

/** Build the replay script for a recorded turn. `messages` = the session's
 *  persisted transcript (SessionStore.messages); an empty/unmatched transcript
 *  falls back to the obs record alone (degraded: tags stripped). */
export function buildReplayScript(turn: TurnRecord, messages: AgentMessage[], paced: boolean): ReplayScript {
  const results: ReplayScript['results'] = {};
  // recorded tool execution durations (obs) — stubs sleep these when paced
  const toolMs = new Map<string, number>();
  for (const s of turn.steps) {
    for (const t of s.tools) {
      if (t.endedAt != null) toolMs.set(t.toolCallId, t.endedAt - t.startedAt);
      // obs result as the fallback; the transcript's toolResult wins below
      results[t.toolCallId] = {
        result: t.result ?? '', ...(t.isError ? { isError: true } : {}),
        ...(t.endedAt != null ? { ms: Math.min(t.endedAt - t.startedAt, MAX_TOOL_MS) } : {}),
      };
    }
  }

  const slice = transcriptSlice(turn, messages);
  const steps: ReplayStep[] = [];
  const fromTranscript = !!slice && slice.some((m) => (m as { role?: string }).role === 'assistant');
  if (fromTranscript) {
    for (const m of slice!) {
      const role = (m as { role?: string }).role;
      if (role === 'assistant') {
        const content = (m as unknown as AssistantMessage).content ?? [];
        steps.push({
          text: content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join(''),
          toolCalls: content.filter((c): c is ToolCall => c.type === 'toolCall'),
          ...stepTimings(turn.steps[steps.length]),
        });
      } else if (role === 'toolResult') {
        const tr = m as unknown as { toolCallId: string; content: Array<{ type?: string; text?: string }>; isError?: boolean };
        results[tr.toolCallId] = {
          result: textOf(tr.content ?? []),
          ...(tr.isError ? { isError: true } : {}),
          ...(toolMs.has(tr.toolCallId) ? { ms: Math.min(toolMs.get(tr.toolCallId)!, MAX_TOOL_MS) } : {}),
        };
      }
    }
  }
  // obs-record fallback (the transcript is bounded — history trim loses old
  // turns): rawText (recorded since 2026-07-17) keeps the [face:]/[move] tags;
  // only a pre-rawText recording is DEGRADED (tag-stripped text).
  let degraded = false;
  if (!fromTranscript) {
    for (const s of turn.steps) {
      if (s.rawText == null && (s.text ?? '') !== '') degraded = true;
      steps.push({
        text: s.rawText ?? s.text ?? '',
        toolCalls: s.tools.filter((t) => !isSyntheticTag(t.toolName)).map((t) => ({
          type: 'toolCall', id: t.toolCallId, name: t.toolName,
          arguments: (t.args ?? {}) as Record<string, never>,
        })),
        ...stepTimings(s),
      });
    }
  }

  return {
    steps, results,
    src: { sessionId: turn.sessionId, turnId: turn.turnId },
    triggerText: turn.trigger?.text ?? '',
    paced,
    ...(degraded ? { degraded: true } : {}),
  };
}

// ── the scripted transport ───────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function replayMessage(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content,
    api: 'openai-completions', provider: 'replay', model: 'replay',
    usage: ZERO_USAGE, stopReason, timestamp: Date.now(),
  };
}

/** Abortable sleep — a superseded/cancelled replay must unwind promptly. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done);
  });
}

/** Sentence-ish chunks, so paced text streams like a real model's deltas. */
function chunksOf(text: string): string[] {
  return text.match(/[^.!?…\n]*[.!?…\n]+["')\]]*\s*|[^.!?…\n]+$/g) ?? (text ? [text] : []);
}

/**
 * Scripted transport: pi calls this once per step; each call shifts the next
 * recorded step (the session.test.ts pattern). Script exhausted — the live
 * loop asked for a step past the recording (e.g. the source turn was cut on
 * toolUse) — ends cleanly with an empty stop.
 */
export function makeReplayStreamFn(script: ReplayScript): StreamFn {
  let idx = 0;
  return ((_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const step = script.steps[idx++];
    const signal = options?.signal;

    void (async () => {
      const finish = (msg: AssistantMessage) => {
        if (msg.stopReason === 'aborted' || msg.stopReason === 'error') {
          stream.push({ type: 'error', reason: msg.stopReason as 'aborted', error: msg });
        } else {
          stream.push({ type: 'done', reason: msg.stopReason as 'stop' | 'toolUse', message: msg });
        }
        stream.end(msg);
      };
      const abortedMsg = (text: string) =>
        ({ ...replayMessage(text ? [{ type: 'text', text }] : [], 'aborted'), errorMessage: 'replay aborted' });

      if (!step) { finish(replayMessage([], 'stop')); return; }

      stream.push({ type: 'start', partial: replayMessage([], 'stop') });

      // first-token marker at the ORIGINAL ttft — a whitespace THINKING delta:
      // it stamps stream-start (WaitForToken matches the recording) without
      // counting as answer text, so the replay's own ttftText/thinking metrics
      // reproduce the original's thinking phase too. The thinking gap
      // (ttftText − ttft) then rides ahead of the first sentence.
      const ttft = step.ttftMs ?? step.ttftTextMs;
      let preTextGap = Math.max(0, (step.ttftTextMs ?? 0) - (ttft ?? 0));
      if (script.paced && ttft) {
        await sleep(ttft, signal);
        if (signal?.aborted) { finish(abortedMsg('')); return; }
        stream.push({ type: 'thinking_delta', contentIndex: 0, delta: ' ', partial: replayMessage([{ type: 'thinking', thinking: ' ' }], 'stop') });
      }

      // text deltas — partials carry the ACCUMULATED text (the session's
      // sentence streamer reads the full partial message, not the delta).
      // Each sentence-chunk sleeps ITS OWN share first, so sentences complete
      // (→ speak frames fire) at the recording's cadence.
      const chunks = chunksOf(step.text);
      const totalChars = step.text.length || 1;
      let acc = '';
      for (const chunk of chunks) {
        if (script.paced && (preTextGap || step.streamMs)) {
          await sleep(preTextGap + Math.round((step.streamMs ?? 0) * (chunk.length / totalChars)), signal);
          preTextGap = 0;
        }
        if (signal?.aborted) { finish(abortedMsg(acc)); return; }
        acc += chunk;
        stream.push({
          type: 'text_delta', contentIndex: 0, delta: chunk,
          partial: replayMessage([{ type: 'text', text: acc }], 'stop'),
        });
      }

      const content: AssistantMessage['content'] = [
        ...(step.text ? [{ type: 'text', text: step.text } satisfies TextContent] : []),
        ...step.toolCalls,
      ];
      const stopReason = step.toolCalls.length > 0 ? 'toolUse' as const : 'stop' as const;
      let ci = step.text ? 1 : 0;
      for (const tc of step.toolCalls) {
        stream.push({ type: 'toolcall_end', contentIndex: ci++, toolCall: tc, partial: replayMessage(content, stopReason) });
      }
      finish(replayMessage(content, stopReason));
    })();

    return stream;
  }) as StreamFn;
}

// ── tool side-effect policy ──────────────────────────────────────────────────

/**
 * Wrap the turn's tool list for replay: embodiment tools stay REAL; everything
 * else returns its recorded result (matched by toolCallId — exact, since the
 * canned assistant messages reuse the recorded ids). When paced, stubs sleep
 * the recorded execution duration so downstream sequencing keeps its shape.
 */
export function wrapToolsForReplay(tools: AgentTool<any>[], script: ReplayScript): AgentTool<any>[] {
  return tools.map((t) => {
    if (isEmbodiment(t.name)) return t;
    return {
      ...t,
      execute: async (toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        const rec = script.results[toolCallId];
        if (script.paced && rec?.ms) await sleep(rec.ms, signal);
        if (rec?.isError) throw new Error(rec.result || `replay: recorded ${t.name} error`);
        return {
          content: [{ type: 'text' as const, text: rec?.result ?? '(replay stub — no recorded result)' }],
          details: undefined,
        };
      },
    };
  });
}
