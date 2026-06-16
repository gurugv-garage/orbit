import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';
import { PerceptionStudio } from './PerceptionStudio';

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
interface GallerySample { index: number; photo?: string }
interface GalleryPerson { name: string; samples: GallerySample[] }

export function Perception() {
  const [docks, setDocks] = useState<Record<string, DockWorldState>>({});
  const [gallery, setGallery] = useState<GalleryPerson[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadGallery = useCallback(() => {
    api.get<{ people?: GalleryPerson[]; names?: string[] }>('/perception/gallery')
      .then((g) => setGallery(g.people ?? (g.names ?? []).map((name) => ({ name, samples: [] }))))
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
  const removeSample = (name: string, index: number) => {
    api.post('/perception/gallery/sample/remove', { name, index }).then(loadGallery).catch(() => {});
  };
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const list = Object.values(docks).sort((a, b) => a.dockId.localeCompare(b.dockId));

  return (
    <section>
      <h2 className="title">Perception</h2>
      <p className="subtitle">What the station's stream processors understand about each dock.</p>

      {/* Always-on perception PoC: publish this laptop's A/V, steer the vision
          instruction, and watch the rolling observations stream. */}
      <div style={{ marginBottom: 24 }}>
        <div className="side-section-label" style={{ marginBottom: 8 }}>Live perception studio</div>
        <PerceptionStudio />
      </div>

      {/* Known faces — everyone the dock has been told to remember. */}
      <div style={{ marginBottom: 20 }}>
        <div className="side-section-label" style={{ marginBottom: 8 }}>Known faces ({gallery.length})</div>
        {gallery.length === 0 ? (
          <div className="empty">No one enrolled yet. Tell the dock "remember I'm &lt;name&gt;", or use the 🪪 Enroll button on the Live wall.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {gallery.map((p) => {
              const cover = p.samples.find((s) => s.photo) ?? p.samples[0];
              const isOpen = expanded.has(p.name);
              return (
                <div key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 12, background: '#0b0e16', alignItems: 'center' }}>
                  {/* Cover thumbnail — click to expand all of this person's captures. */}
                  <button onClick={() => toggle(p.name)} title={isOpen ? 'Collapse' : `Show ${p.samples.length} face${p.samples.length === 1 ? '' : 's'}`} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
                    {cover?.photo ? (
                      <img src={`data:image/jpeg;base64,${cover.photo}`} alt={p.name}
                        style={{ width: 72, height: 72, borderRadius: 10, objectFit: 'cover', background: '#070a11' }} />
                    ) : (
                      <div style={{ width: 72, height: 72, borderRadius: 10, background: '#070a11', display: 'grid', placeItems: 'center', fontSize: 28 }}>👤</div>
                    )}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span className="mono" style={{ fontSize: 12 }}>{p.name}</span>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>×{p.samples.length}</span>
                    <button onClick={() => forget(p.name)} title={`Forget ${p.name} entirely`} style={{ padding: '0 4px' }}>✕</button>
                  </div>

                  {/* Expanded: every stored fingerprint with its own photo + delete. */}
                  {isOpen && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 168, justifyContent: 'center', borderTop: '1px solid #1c2233', paddingTop: 6 }}>
                      {p.samples.map((s) => (
                        <div key={s.index} style={{ position: 'relative' }}>
                          {s.photo ? (
                            <img src={`data:image/jpeg;base64,${s.photo}`} alt={`${p.name} #${s.index}`}
                              style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', background: '#070a11' }} />
                          ) : (
                            <div style={{ width: 48, height: 48, borderRadius: 8, background: '#070a11', display: 'grid', placeItems: 'center', fontSize: 18 }}>👤</div>
                          )}
                          <button onClick={() => removeSample(p.name, s.index)} title="Delete this face"
                            style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, lineHeight: '14px', padding: 0, borderRadius: 9, fontSize: 11 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
