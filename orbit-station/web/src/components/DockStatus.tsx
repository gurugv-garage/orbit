import { useDocks, useNow, relTime } from '../lib/useDocks';
import type { DockInfo, DockComponent } from '../lib/protocol';

/**
 * Compact, always-on dock status for the sidebar. Shows every named dock with
 * its app + firmware online dots — visible from every page, not just Overview.
 */
export function DockStatus() {
  const docks = useDocks();
  const now = useNow();

  if (docks.length === 0) {
    return <div className="side-docks"><div className="muted" style={{ fontSize: 11 }}>no docks</div></div>;
  }
  return (
    <div className="side-docks">
      {docks.map((d) => <SideDock key={d.name} dock={d} now={now} />)}
    </div>
  );
}

function SideDock({ dock, now }: { dock: DockInfo; now: number }) {
  return (
    <div className="side-dock">
      <div className="side-dock-name">{dock.name}</div>
      {dock.components.map((c) => <MemberLine key={c.component} kind={c.component} m={c} now={now} />)}
    </div>
  );
}

function MemberLine({ kind, m, now }: { kind: string; m?: DockComponent; now: number }) {
  const cls = !m ? 'off' : m.online ? 'on' : 'wait';
  return (
    <div className="side-dock-row" title={memberTitle(kind, m)}>
      <span className={`dot ${cls}`} />
      <span className="side-dock-kind">{kind}</span>
      <span className="side-dock-when">
        {!m ? '—' : m.online ? 'online' : (m.lastSeen != null ? relTime(m.lastSeen, now) : 'offline')}
      </span>
    </div>
  );
}

function memberTitle(kind: string, m?: DockComponent): string {
  if (!m) return `${kind}: not connected`;
  const parts = [m.id];
  if (m.build != null) parts.push(`build ${m.build}`);
  // link health (from the device heartbeat): rssi is the at-a-glance signal —
  // the lesson from the C3 range debug, so "why offline?" is visible here.
  if (m.health?.rssi != null) parts.push(`rssi ${m.health.rssi}dBm`);
  if (m.health?.reconnects != null) parts.push(`reconnects ${m.health.reconnects}`);
  if (m.ip) parts.push(m.ip);
  if (m.lastSeen) parts.push(`seen ${new Date(m.lastSeen).toLocaleTimeString()}`);
  return `${kind}: ${m.online ? 'online' : 'offline'} · ${parts.join(' · ')}`;
}
