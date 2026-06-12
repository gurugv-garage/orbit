import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';
import { useDocks, useNow, relTime } from '../lib/useDocks';
import type { AgentEventDto, DockInfo, DockComponent, PeerInfo } from '../lib/protocol';

export function Overview() {
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const docks = useDocks();
  const now = useNow();
  const [uptime, setUptime] = useState<number | null>(null);
  const [sessions, setSessions] = useState(new Set<string>());
  const [turns, setTurns] = useState(0);

  const refresh = useCallback(() => {
    api.get<PeerInfo[]>('/station/peers').then(setPeers).catch(() => {});
    api.get<{ uptimeSec: number }>('/station/health').then((h) => setUptime(h.uptimeSec)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // station topic: peer join/leave → refresh peers/uptime
  useStationEvents('station', useCallback(() => refresh(), [refresh]));
  useStationEvents('obs', useCallback((e) => {
    const ev = e.payload as AgentEventDto;
    setSessions((s) => (s.has(ev.sessionId) ? s : new Set(s).add(ev.sessionId)));
    if (ev.kind === 'TurnStart') setTurns((n) => n + 1);
  }, []));

  return (
    <section>
      <h2 className="title">Overview</h2>
      <p className="subtitle">Live state of the orbit fleet.</p>

      <div className="grid">
        <div className="card"><h3>Docks</h3><div className="stat">{docks.length}</div><div className="muted">named component sets (phone · body · …)</div></div>
        <div className="card"><h3>Peers connected</h3><div className="stat">{peers.length}</div><div className="muted">devices · browsers</div></div>
        <div className="card"><h3>Agent sessions</h3><div className="stat">{sessions.size}</div><div className="muted">observed this UI session</div></div>
        <div className="card"><h3>Station uptime</h3><div className="stat">{uptime == null ? '—' : fmtUptime(uptime)}</div><div className="muted">{turns} turns seen</div></div>
      </div>

      <h3 style={{ margin: '22px 0 10px', color: 'var(--accent)' }}>Docks</h3>
      {docks.length === 0 ? (
        <div className="empty">No docks registered. A dock = the components (phone app, body firmware, …) declaring the same <code>dock</code> name in their <code>hello</code> (e.g. <code>anne-bot</code>).</div>
      ) : (
        <div className="grid">{docks.map((d) => <DockCard key={d.name} dock={d} now={now} />)}</div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Raw peer roster</h3>
        {peers.length === 0 ? (
          <div className="muted">No peers connected. Start the dock app, ESP32, or run <code>npm run smoke</code>.</div>
        ) : (
          <table>
            <thead><tr><th>role</th><th>id</th><th>dock</th><th>component</th><th>build</th><th>ip</th><th>seen</th></tr></thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.id + p.role}>
                  <td><span className={`pill ${roleClass(p.role)}`}>{p.role}</span></td>
                  <td className="mono">{p.id}</td>
                  <td className="mono">{p.dock ?? '—'}</td>
                  <td className="mono">{p.component ?? '—'}</td>
                  <td className="mono">{p.build ?? '—'}</td>
                  <td className="muted mono">{p.ip ?? '—'}</td>
                  <td className="muted" title={new Date(p.lastSeen).toLocaleString()}>{relTime(p.lastSeen, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function DockCard({ dock, now }: { dock: DockInfo; now: number }) {
  const allOffline = dock.components.every((c) => !c.online);
  const forget = () => {
    if (!confirm(`Forget dock "${dock.name}"? (its persisted manifest + last-known components)`)) return;
    api.del(`/docks/${encodeURIComponent(dock.name)}`).catch(() => {});
  };
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>{dock.name}</h3>
        <div className="spacer" />
        {/* test docks + retired hardware shouldn't haunt the fleet forever;
            the server refuses while any component is live. */}
        {allOffline && <button onClick={forget} title="forget this dock">forget ✕</button>}
      </div>
      {dock.components.map((c) => (
        <MemberRow key={c.component} kind={c.component} m={c} now={now}
          extra={c.caps?.length ? c.caps.join(' ') : undefined} />
      ))}
    </div>
  );
}

function MemberRow({ kind, m, now, extra }: { kind: string; m?: DockComponent; now: number; extra?: string }) {
  const cls = !m ? 'off' : m.online ? 'on' : 'wait';
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
      <div className="row">
        <span className={`dot ${cls}`} />
        <b>{kind}</b>
        <span className="muted">{!m ? 'not connected' : m.online ? 'online' : 'offline'}</span>
        <div className="spacer" />
        {m?.lastSeen != null && (
          <span className="muted" style={{ fontSize: 11 }} title={new Date(m.lastSeen).toLocaleString()}>
            seen {relTime(m.lastSeen, now)}
          </span>
        )}
      </div>
      {m && (
        <div className="muted mono" style={{ fontSize: 11, marginLeft: 18 }}>
          {m.id}{m.build != null ? ` · build ${m.build}` : ''}{m.ip ? ` · ${m.ip}` : ''}{extra ? ` · ${extra}` : ''}
        </div>
      )}
      {m?.links && (
        <div className="row" style={{ marginLeft: 18, marginTop: 3, gap: 6 }}>
          {Object.entries(m.links).map(([name, up]) => (
            <span key={name} className={`pill ${up ? 'good' : 'warn'}`} style={{ fontSize: 10 }}>
              {linkLabel(name)} {up ? '✓' : '✕'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Friendly names for the mesh-link keys peers report. */
function linkLabel(key: string): string {
  switch (key) {
    case 'body': return '→ body';
    case 'llm': return '→ llm';
    case 'phoneClient': return '← phone';
    default: return key;
  }
}

function roleClass(role: string): string {
  return role === 'device' ? 'good' : 'acc';
}
function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
