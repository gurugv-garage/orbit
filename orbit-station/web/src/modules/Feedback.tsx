import { useCallback, useEffect, useState } from 'react';
import { useStationEvents } from '../lib/useStation';

/**
 * Feedback console (docs/features-todo/feedback-flow.md) — the review surface.
 * Each feedback is a full debugging dump of a dock session (the user's words +
 * the session's trace/timings/perception/version), captured to an MD file under
 * .data/feedback/. This view lists them (newest first) and renders the full MD
 * on the right; delete removes one. Capture happens elsewhere (app long-press,
 * the record_feedback brain tool, or POST /api/feedback) — this is read/review.
 */

interface FeedbackMeta {
  id: string;
  dock: string;
  sessionId?: string;
  turnId?: string;
  createdAt: string;
  source: 'app-button' | 'brain-tool' | 'api';
  reason?: string;
}
interface FeedbackDetail { id: string; file: string; dir: string; path: string; meta: FeedbackMeta; content: string }

const SOURCE_ICO: Record<FeedbackMeta['source'], string> = {
  'app-button': '📱', 'brain-tool': '🤖', 'api': '🛰',
};

export function Feedback() {
  const [items, setItems] = useState<FeedbackMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/feedback/');
      if (r.ok) setItems(await r.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // live: a new capture re-publishes nothing yet, but the app-button path lands
  // on the `feedback` topic — refresh the list whenever we hear it.
  useStationEvents('feedback', () => { void refresh(); });

  const open = useCallback(async (id: string) => {
    setSelected(id);
    setDetail(null);
    try {
      const r = await fetch(`/api/feedback/${encodeURIComponent(id)}`);
      if (r.ok) setDetail(await r.json());
    } catch { /* ignore */ }
  }, []);

  const remove = useCallback(async (id: string) => {
    if (!confirm('Delete this feedback?')) return;
    setBusy(true);
    try {
      await fetch(`/api/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (selected === id) { setSelected(null); setDetail(null); }
      await refresh();
    } finally { setBusy(false); }
  }, [selected, refresh]);

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
      {/* list */}
      <div style={{ width: 340, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #ffffff14', paddingRight: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ opacity: 0.8 }}>Feedback ({items.length})</strong>
          <button onClick={() => void refresh()} style={btnGhost}>↻</button>
        </div>
        {items.length === 0 && <div style={{ opacity: 0.4, fontSize: 13, padding: '8px 0' }}>No feedback yet. Long-press the version label on a dock, or the agent can call <code>record_feedback</code>.</div>}
        {items.map((m) => (
          <div
            key={m.id}
            onClick={() => void open(m.id)}
            style={{
              padding: '8px 10px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
              background: selected === m.id ? '#ffffff14' : '#ffffff08',
              border: selected === m.id ? '1px solid #7aa2ff66' : '1px solid transparent',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{SOURCE_ICO[m.source]} {m.dock}</span>
              <span style={{ opacity: 0.4, fontSize: 11 }}>{fmtWhen(m.createdAt)}</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.reason || <em style={{ opacity: 0.5 }}>(no reason)</em>}
            </div>
            {m.sessionId && <div style={{ fontSize: 10, opacity: 0.4, marginTop: 2 }}>session {m.sessionId}</div>}
          </div>
        ))}
      </div>

      {/* detail */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {!detail && <div style={{ opacity: 0.4, padding: 24 }}>Select a feedback to read its full dump.</div>}
        {detail && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong>{detail.meta.dock} · {detail.meta.reason || '(no reason)'}</strong>
              <button onClick={() => void remove(detail.id)} disabled={busy} style={btnDanger}>Delete</button>
            </div>
            {/* actual on-disk location, so you can open it directly for analysis */}
            <div
              title="click to copy the full path"
              onClick={() => navigator.clipboard?.writeText(detail.path)}
              style={{ fontSize: 11, opacity: 0.55, fontFamily: 'monospace', marginBottom: 10, cursor: 'pointer', wordBreak: 'break-all' }}
            >
              📁 {detail.path} <span style={{ opacity: 0.5 }}>(click to copy)</span>
            </div>
            <pre style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5,
              background: '#0c0e16', border: '1px solid #ffffff14', borderRadius: 8, padding: 14, margin: 0,
            }}>{detail.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

const btnGhost: React.CSSProperties = { background: 'transparent', border: '1px solid #ffffff22', color: '#fff', borderRadius: 6, cursor: 'pointer', padding: '2px 8px' };
const btnDanger: React.CSSProperties = { background: '#ff5a5a22', border: '1px solid #ff5a5a55', color: '#ff9a9a', borderRadius: 6, cursor: 'pointer', padding: '4px 12px' };
