import { useState } from 'react';
import { api } from '../lib/station';
import { useDocks, useNow, relTime } from '../lib/useDocks';
import { useUnclaimed, claimDevice, unbindDevice, type UnclaimedDevice } from '../lib/useUnclaimed';
import type { DockInfo, DockComponent } from '../lib/protocol';

/**
 * Docks — the home for dock identity & composition (runtime dock binding,
 * docs/decision-traces/runtime-dock-binding.md):
 *   - Unclaimed devices: a connected device with no dock yet → claim it onto a dock.
 *   - Docks: each named dock's components; unbind a device (re-park unclaimed) or
 *     forget a whole offline dock.
 * The dock name is assigned here at runtime, not compiled into the device.
 */
export function Docks() {
  const docks = useDocks();
  const { devices: unclaimed, refresh: refreshUnclaimed } = useUnclaimed();
  const now = useNow();
  const dockNames = docks.map((d) => d.name);

  return (
    <section>
      <h2 className="title">Docks</h2>
      <p className="subtitle">
        Assign each device to a dock at runtime. A dock = a named set of components
        (phone · body · …); the binding survives app uninstall / firmware reflash.
      </p>

      <h3 style={{ margin: '18px 0 10px', color: 'var(--warn, #e0a030)' }}>
        Unclaimed devices
        <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> · dialed in, no dock yet</span>
      </h3>
      {unclaimed.length === 0 ? (
        <div className="empty">
          No unclaimed devices. A freshly-installed phone or reflashed body dials in here
          with just its hardware id; claim it onto a dock and it goes live.
        </div>
      ) : (
        <div className="grid">
          {unclaimed.map((d) => (
            <ClaimCard key={d.id} device={d} now={now} docks={dockNames} onChanged={refreshUnclaimed} />
          ))}
        </div>
      )}

      <h3 style={{ margin: '22px 0 10px', color: 'var(--accent)' }}>Docks</h3>
      {docks.length === 0 ? (
        <div className="empty">
          No docks yet. Claim an unclaimed device above (or set a dev-override DOCK_NAME)
          to create one.
        </div>
      ) : (
        <div className="grid">
          {docks.map((d) => <DockCard key={d.name} dock={d} now={now} onChanged={refreshUnclaimed} />)}
        </div>
      )}
    </section>
  );
}

/** An unclaimed device with an inline "claim → dock" form. The slot (phone/body)
 *  is derived server-side from the device kind, so the operator only picks a name. */
function ClaimCard(
  { device, now, docks, onChanged }:
  { device: UnclaimedDevice; now: number; docks: string[]; onChanged: () => void },
) {
  const [dock, setDock] = useState('');
  const [busy, setBusy] = useState(false);
  const slot = device.kind === 'dock-android-app' ? 'phone' : device.kind === 'dock-body-fw' ? 'body' : '?';

  const claim = () => {
    const name = dock.trim();
    if (!name || busy) return;
    setBusy(true);
    claimDevice(device.id, name).then(onChanged).catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <div className="card" data-testid="claim-card" data-device-id={device.id}>
      <div className="row">
        <span className="dot wait" />
        <h3 style={{ margin: 0 }}>{device.label ?? device.kind ?? 'device'}</h3>
        <div className="spacer" />
        <span className="pill warn" style={{ fontSize: 10 }}>unclaimed</span>
      </div>
      <div className="muted mono" style={{ fontSize: 11, margin: '4px 0' }}>
        {device.id} · slot {slot}{device.build != null ? ` · build ${device.build}` : ''}
        {device.ip ? ` · ${device.ip}` : ''} · seen {relTime(device.lastSeen, now)}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <input
          list="known-docks"
          placeholder="dock name (e.g. anne-bot)"
          value={dock}
          onChange={(e) => setDock(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') claim(); }}
          data-testid="claim-input"
          style={{ flex: 1 }}
        />
        <datalist id="known-docks">{docks.map((d) => <option key={d} value={d} />)}</datalist>
        <button onClick={claim} disabled={!dock.trim() || busy} data-testid="claim-btn">
          {busy ? 'claiming…' : 'claim'}
        </button>
      </div>
    </div>
  );
}

function DockCard({ dock, now, onChanged }: { dock: DockInfo; now: number; onChanged: () => void }) {
  const allOffline = dock.components.every((c) => !c.online);
  const forget = () => {
    if (!confirm(`Forget dock "${dock.name}"? (its persisted manifest + last-known components)`)) return;
    api.del(`/docks/${encodeURIComponent(dock.name)}`).then(onChanged).catch(() => {});
  };
  return (
    <div className="card" data-testid="dock-card" data-dock={dock.name}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{dock.name}</h3>
        <div className="spacer" />
        {allOffline && <button onClick={forget} title="forget this dock">forget ✕</button>}
      </div>
      {dock.components.map((c) => (
        <ComponentRow key={c.component} m={c} now={now} onChanged={onChanged} />
      ))}
    </div>
  );
}

/** One dock component, with an "unbind" action that re-parks the device unclaimed. */
function ComponentRow(
  { m, now, onChanged }: { m: DockComponent; now: number; onChanged: () => void },
) {
  const [busy, setBusy] = useState(false);
  const cls = m.online ? 'on' : 'wait';
  const unbind = () => {
    if (!confirm(`Unbind ${m.component} (${m.id}) from this dock? It re-parks UNCLAIMED on its next connect.`)) return;
    setBusy(true);
    unbindDevice(m.id).then(onChanged).catch(() => {}).finally(() => setBusy(false));
  };
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
      <div className="row">
        <span className={`dot ${cls}`} />
        <b>{m.component}</b>
        <span className="muted">{m.online ? 'online' : 'offline'}</span>
        <div className="spacer" />
        {m.lastSeen != null && (
          <span className="muted" style={{ fontSize: 11 }} title={new Date(m.lastSeen).toLocaleString()}>
            seen {relTime(m.lastSeen, now)}
          </span>
        )}
        <button
          onClick={unbind}
          disabled={busy}
          title="forget this device's dock binding (re-park unclaimed)"
          data-testid="unbind-btn"
          data-device-id={m.id}
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          {busy ? '…' : 'unbind'}
        </button>
      </div>
      <div className="muted mono" style={{ fontSize: 11, marginLeft: 18 }}>
        {m.id}{m.build != null ? ` · build ${m.build}` : ''}{m.ip ? ` · ${m.ip}` : ''}
        {m.caps?.length ? ` · ${m.caps.join(' ')}` : ''}
      </div>
    </div>
  );
}
