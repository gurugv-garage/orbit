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
  const [gallery, setGallery] = useState<{ name: string; photo?: string }[]>([]);

  const loadGallery = useCallback(() => {
    api.get<{ people?: { name: string; photo?: string }[]; names?: string[] }>('/perception/gallery')
      .then((g) => setGallery(g.people ?? (g.names ?? []).map((name) => ({ name }))))
      .catch(() => {});
  }, []);
  const load = useCallback(() => {
    api.get<DockWorldState[]>('/perception')
      .then((list) => setDocks(Object.fromEntries(list.map((d) => [d.dockId, d]))))
      .catch(() => {});
    loadGallery();
  }, [loadGallery]);
  useEffect(load, [load]);

  // Live aggregate states (the state module broadcasts kind 'state').
  useStationEvents('perception', useCallback((e) => {
    if (e.kind === 'enroll-result') { loadGallery(); return; }
    if (e.kind !== 'state') return;
    const s = e.payload as DockWorldState;
    setDocks((prev) => ({ ...prev, [s.dockId]: s }));
  }, [loadGallery]));

  const forget = (name: string) => {
    api.post('/perception/gallery/remove', { name }).then(loadGallery).catch(() => {});
  };

  const list = Object.values(docks).sort((a, b) => a.dockId.localeCompare(b.dockId));

  return (
    <section>
      <h2 className="title">Perception</h2>
      <p className="subtitle">What the station's stream processors understand about each dock.</p>

      {/* Known faces — everyone the dock has been told to remember. */}
      <div style={{ marginBottom: 20 }}>
        <div className="side-section-label" style={{ marginBottom: 8 }}>Known faces ({gallery.length})</div>
        {gallery.length === 0 ? (
          <div className="empty">No one enrolled yet. Tell the dock "remember I'm &lt;name&gt;", or use the 🪪 Enroll button on the Live wall.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {gallery.map((p) => (
              <div key={p.name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 84 }}>
                {p.photo ? (
                  <img
                    src={`data:image/jpeg;base64,${p.photo}`}
                    alt={p.name}
                    style={{ width: 72, height: 72, borderRadius: 10, objectFit: 'cover', background: '#0b0e16' }}
                  />
                ) : (
                  <div style={{ width: 72, height: 72, borderRadius: 10, background: '#0b0e16', display: 'grid', placeItems: 'center', fontSize: 28 }}>👤</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="mono" style={{ fontSize: 12 }}>{p.name}</span>
                  <button onClick={() => forget(p.name)} title={`Forget ${p.name}`} style={{ padding: '0 4px' }}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
