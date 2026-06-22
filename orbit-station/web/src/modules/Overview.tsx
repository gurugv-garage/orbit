import { useCallback, useEffect, useState } from 'react';
import { useStationEvents } from '../lib/useStation';
import { useDocks, useNow, relTime } from '../lib/useDocks';
import { api } from '../lib/station';
import type { AgentEventDto, PeerInfo } from '../lib/protocol';

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

      <div className="muted" style={{ margin: '18px 0 0' }}>
        Manage docks & claim devices in the <a href="#docks">Docks</a> tab.
      </div>

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

function roleClass(role: string): string {
  return role === 'device' ? 'good' : 'acc';
}
function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
