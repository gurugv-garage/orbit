import { useCallback, useState } from 'react';
import { useStationEvents } from '../lib/useStation';

interface Obs { ts: number; topic: string; kind: string; source: string; }

export function Mind() {
  const [feed, setFeed] = useState<Obs[]>([]);

  useStationEvents('mind', useCallback((e) => {
    if (e.kind !== 'observation') return;
    const saw = (e.payload as { saw: { topic: string; kind: string; source: string } }).saw;
    setFeed((f) => [{ ts: e.ts, ...saw }, ...f].slice(0, 120));
  }, []));

  return (
    <section>
      <h2 className="title">Mind</h2>
      <p className="subtitle">Awareness layer (stub) — watches the whole bus, takes no action yet.</p>
      <div className="card">
        <h3>What mind sees</h3>
        {feed.length === 0 ? (
          <div className="muted">Quiet. Mind echoes every bus message here once activity starts.</div>
        ) : (
          <div className="feed">
            {feed.map((o, i) => (
              <div className="ln" key={i}>
                <span className="ts">{new Date(o.ts).toLocaleTimeString()}</span>
                <span className="tp">{o.topic}/{o.kind}</span>
                <span className="muted mono">{o.source}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
