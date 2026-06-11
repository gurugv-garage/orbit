import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';

interface DockWorldState {
  dockId: string;
  present: boolean;
  identity?: { name: string; confidence: number; since: number };
  emotion?: { kind: string; confidence: number };
  recentTranscript: { text: string; ts: number }[];
  lastUpdated: number;
}

/**
 * Perception panel — the per-dock "world state" the station's stream processors
 * produce (presence, identity, emotion, recent transcript). Loads via
 * GET /api/perception and updates live on the `perception` topic's `state` kind.
 */
export function Perception() {
  const [docks, setDocks] = useState<Record<string, DockWorldState>>({});

  const load = useCallback(() => {
    api.get<DockWorldState[]>('/perception')
      .then((list) => setDocks(Object.fromEntries(list.map((d) => [d.dockId, d]))))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  // Live aggregate states (the state module broadcasts kind 'state').
  useStationEvents('perception', useCallback((e) => {
    if (e.kind !== 'state') return;
    const s = e.payload as DockWorldState;
    setDocks((prev) => ({ ...prev, [s.dockId]: s }));
  }, []));

  const list = Object.values(docks).sort((a, b) => a.dockId.localeCompare(b.dockId));

  return (
    <section>
      <h2 className="title">Perception</h2>
      <p className="subtitle">What the station's stream processors understand about each dock.</p>

      {list.length === 0 ? (
        <div className="empty">No perception yet. A dock must be streaming (the presence processor marks it present); face recognition + audio land next.</div>
      ) : (
        <div className="grid">
          {list.map((d) => (
            <div key={d.dockId} className="card" style={{ padding: 16, borderRadius: 12, background: '#0b0e16' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong className="mono">{d.dockId}</strong>
                <span style={{ color: d.present ? '#6ad19a' : '#888' }}>
                  {d.present ? '● present' : '○ absent'}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.7 }}>
                <div>identity: <b>{d.identity?.name ?? '—'}</b>{d.identity ? ` (${(d.identity.confidence * 100).toFixed(0)}%)` : ''}</div>
                <div>emotion: {d.emotion?.kind ?? '—'}</div>
                {d.recentTranscript.length > 0 && (
                  <div style={{ marginTop: 6, opacity: 0.8 }}>
                    “{d.recentTranscript[d.recentTranscript.length - 1]!.text}”
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
