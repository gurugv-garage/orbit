import { useCallback, useRef, useState } from 'react';
import { useStationEvents } from '../lib/useStation';
import type { AgentEventDto } from '../lib/protocol';

/** Live-reconstructed view models, mirroring the server's store shape. */
interface ToolVM { id: string; name: string; args?: unknown; isError?: boolean; }
interface StepVM { idx: number; model?: string; stopReason?: string; text?: string; tools: ToolVM[]; out?: number; }
interface TurnVM { id: string; sessionId: string; startedAt: number; ended: boolean; steps: StepVM[]; }

export function Observability() {
  const [turns, setTurns] = useState<TurnVM[]>([]);
  const turnIndex = useRef(new Map<string, number>()); // turnId → array index

  const onEvent = useCallback((frame: { payload: unknown }) => {
    const ev = frame.payload as AgentEventDto;
    setTurns((prev) => {
      const next = prev.slice();
      let i = turnIndex.current.get(ev.turnId);
      if (i == null) {
        i = next.length;
        turnIndex.current.set(ev.turnId, i);
        next.push({ id: ev.turnId, sessionId: ev.sessionId, startedAt: ev.ts, ended: false, steps: [] });
      }
      const turn = { ...next[i]! , steps: next[i]!.steps.slice() };
      applyEvent(turn, ev);
      next[i] = turn;
      // keep last 40 turns
      return next.slice(-40);
    });
  }, []);

  useStationEvents('obs', onEvent);

  const shown = turns.slice().reverse();

  return (
    <section>
      <h2 className="title">Observability</h2>
      <p className="subtitle">agent-core Session ⊃ Turn ⊃ Step ⊃ LLM-call, streamed live.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">{turns.length} turns · live from WS</span>
        <div className="spacer" />
        <button onClick={() => { turnIndex.current.clear(); setTurns([]); }}>clear</button>
      </div>
      {shown.length === 0 ? (
        <div className="empty">No agent activity yet. Connect the dock app (it publishes on the <code>obs</code> topic) or run <code>npm run smoke</code>.</div>
      ) : (
        shown.map((t) => <TurnRow key={t.id + t.sessionId} turn={t} />)
      )}
    </section>
  );
}

function TurnRow({ turn }: { turn: TurnVM }) {
  const llmCalls = turn.steps.filter((s) => s.tools.length > 0).length + (turn.ended ? 1 : 0);
  return (
    <details className="turn" open>
      <summary>
        <span className="mono">{turn.id}</span>{' '}
        <span className="muted">· {turn.sessionId}</span>{' '}
        <span className={`pill ${turn.ended ? 'good' : 'warn'}`}>{turn.ended ? 'done' : 'running'}</span>{' '}
        <span className="muted">{turn.steps.length} steps · ~{llmCalls} LLM calls</span>
      </summary>
      {turn.steps.map((s) => (
        <div className="step" key={s.idx}>
          <div className="row">
            <span className="muted">step {s.idx}</span>
            {s.model && <span className="pill acc">{s.model}</span>}
            {s.stopReason && <span className="muted mono">{s.stopReason}</span>}
            {s.out != null && <span className="muted">{s.out} out-tok</span>}
          </div>
          {s.text && <div style={{ margin: '4px 0' }}>{s.text}</div>}
          {s.tools.map((tc) => (
            <div key={tc.id} className="mono">
              <span className="tool">⚙ {tc.name}</span>{' '}
              <span className="muted">{JSON.stringify(tc.args)}</span>{' '}
              {tc.isError != null && <span className={`pill ${tc.isError ? 'bad' : 'good'}`}>{tc.isError ? 'error' : 'ok'}</span>}
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}

function applyEvent(turn: TurnVM, ev: AgentEventDto): void {
  const last = turn.steps[turn.steps.length - 1];
  switch (ev.kind) {
    case 'TurnEnd':
      turn.ended = true;
      break;
    case 'StepStart':
      turn.steps.push({ idx: turn.steps.length, tools: [] });
      break;
    case 'StepEnd':
      if (last) {
        last.model = ev.data?.model;
        last.stopReason = ev.data?.stopReason;
        last.out = ev.data?.usage?.outputTokens;
      }
      break;
    case 'MessageEnd':
      if (last && ev.data?.text != null) last.text = ev.data.text;
      break;
    case 'ToolExecutionStart':
      if (last && ev.data?.toolCallId) last.tools.push({ id: ev.data.toolCallId, name: ev.data.toolName ?? '?', args: ev.data.args });
      break;
    case 'ToolExecutionEnd': {
      const tc = last?.tools.find((t) => t.id === ev.data?.toolCallId);
      if (tc) tc.isError = ev.data?.isError;
      break;
    }
  }
}
