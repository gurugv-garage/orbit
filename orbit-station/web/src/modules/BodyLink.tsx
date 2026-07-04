import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';
import { DEGREE_RANGE, degreesToUs, hasAngle } from '../lib/bodyAngles';

interface ParamSpec { type: string; unit: string; range: [number | null, number | null]; default?: number; }
interface PartSpec { description?: string; home?: Record<string, number>; params: Record<string, ParamSpec>; }
interface Profile { body: { device_id: string; name: string; parts: Record<string, PartSpec> }; }
type BodyState = Record<string, Record<string, number>>;
interface DockInfo { name: string; components: Array<{ component: string; caps?: string[]; online: boolean }>; }
interface Health { rssi?: number; heap_free?: number; reconnects?: number; ts?: number; }
interface Digest { dock: string; online: boolean; state: BodyState; health?: Health; ts: number; }

/** colour the RSSI glance: green strong, amber usable, red marginal. */
const rssiColor = (rssi?: number): string =>
  rssi == null ? 'var(--dim)' : rssi >= -67 ? 'var(--good)' : rssi >= -75 ? 'var(--accent)' : 'var(--bad)';

/** docks that have a body slot at all (declared or observed). */
const hasBody = (d: DockInfo) =>
  d.components.some((c) => (c.caps ?? []).includes('servo') || c.component === 'body');
const bodyOnline = (d: DockInfo) =>
  d.components.some(
    (c) => ((c.caps ?? []).includes('servo') || c.component === 'body') && c.online,
  );

export function BodyLink() {
  const [docks, setDocks] = useState<DockInfo[]>([]);
  const [dock, setDock] = useState<string>('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<BodyState>({});
  const [online, setOnline] = useState(false);
  // passive link-health, live from the digest (no button) — always shown.
  const [health, setHealth] = useState<Health | null>(null);
  // active packet-loss/RTT probe result (only when the button is pressed).
  const [probe, setProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const checkHealth = useCallback(() => {
    if (!dock) return;
    setProbing(true);
    setProbe('pinging…');
    api.post<{ report?: { sent: number; received: number; lossPct: number; rttMin?: number; rttAvg?: number; rttMax?: number }; error?: string }>(
      `/bodylink/health-check?dock=${encodeURIComponent(dock)}`, {})
      .then((r) => {
        if (r.error || !r.report) { setProbe(`✗ ${r.error ?? 'no report'}`); return; }
        const h = r.report;
        const loss = `${h.lossPct}% loss (${h.received}/${h.sent})`;
        const rtt = h.rttAvg != null ? ` · RTT ${h.rttAvg}ms (${h.rttMin}…${h.rttMax})` : '';
        const ok = h.lossPct === 0;
        setProbe(`${ok ? '✓' : '⚠'} ${loss}${rtt}`);
      })
      .catch((e) => setProbe(`✗ ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setProbing(false));
  }, [dock]);

  // dock list: anything with a body slot; default to the first ONLINE body.
  useEffect(() => {
    api.get<DockInfo[]>('/docks').then((all) => {
      const bodied = all.filter(hasBody);
      setDocks(bodied);
      setDock((cur) => cur || (bodied.find(bodyOnline) ?? bodied[0])?.name || '');
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!dock) return;
    const q = `?dock=${encodeURIComponent(dock)}`;
    api.get<Profile | { error: string }>(`/bodylink/profile${q}`)
      .then((p) => setProfile('body' in p ? p : null)).catch(() => {});
    api.get<{ online?: boolean; state?: BodyState }>(`/bodylink/state${q}`)
      .then((s) => { setState(s.state ?? {}); setOnline(s.online ?? false); }).catch(() => {});
  }, [dock]);
  useEffect(load, [load]);

  // Live updates ride the ~1 Hz digest (it carries the dock, so multi-dock
  // fan-in filters cleanly; raw `state` frames don't name their dock).
  useStationEvents('bodylink', useCallback((e) => {
    if (e.kind === 'digest') {
      const d = e.payload as Digest;
      if (d.dock !== dock) return;
      setState(d.state ?? {});
      setOnline(d.online);
      if (d.health) setHealth(d.health);   // live passive metrics — no button
    } else if (e.kind === 'profile') {
      load(); // a body (re)connected somewhere — re-resolve our view
    }
  }, [dock, load]));

  const picker = docks.length > 1 && (
    <div className="row" style={{ gap: 6, marginBottom: 12 }}>
      {docks.map((d) => (
        <button key={d.name} onClick={() => { setProfile(null); setDock(d.name); }}
          style={dock === d.name ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
          {d.name}{bodyOnline(d) ? ' ●' : ''}
        </button>
      ))}
    </div>
  );

  if (!profile) {
    return (
      <section>
        <h2 className="title">Body Console</h2>
        <p className="subtitle">Drive the body directly — same motion executor the brain uses.</p>
        {picker}
        <div className="empty">
          No body profile{dock ? ` for ${dock}` : ''}. Flash/boot the ESP32 (it dials
          into <code>/ws</code> and sends its profile), or run <code>npm run smoke:brain</code>.
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="title">Body Console</h2>
      <p className="subtitle">
        {dock} · {profile.body.name} · <span className="mono">{profile.body.device_id}</span>
        {' '}· <span style={{ color: online ? 'var(--good)' : 'var(--bad)' }}>{online ? 'online' : 'offline'}</span>
      </p>
      {/* link health — passive metrics live from the heartbeat (always on),
          plus the on-demand packet-loss/RTT probe behind the button. */}
      <p className="subtitle" style={{ marginTop: -6 }}>
        <span className="mono" style={{ fontSize: '0.85em', color: rssiColor(health?.rssi) }}>
          {health?.rssi != null ? `📶 ${health.rssi} dBm` : '📶 —'}
        </span>
        {health?.reconnects != null && (
          <span className="mono" style={{ fontSize: '0.85em', color: 'var(--dim)', marginLeft: 8 }}>
            {health.reconnects} reconnect{health.reconnects === 1 ? '' : 's'}
          </span>
        )}
        {health?.heap_free != null && (
          <span className="mono" style={{ fontSize: '0.85em', color: 'var(--dim)', marginLeft: 8 }}>
            {Math.round(health.heap_free / 1024)}KB heap
          </span>
        )}
        {' '}<button onClick={checkHealth} disabled={!online || probing}
          style={{ padding: '0 8px', fontSize: '0.85em', marginLeft: 8 }}>
          {probing ? 'pinging…' : '🩺 Check conn health'}
        </button>
        {probe && <span className="mono" style={{ marginLeft: 8, fontSize: '0.85em',
          color: probe.startsWith('✓') ? 'var(--good)' : probe.startsWith('⚠') ? 'var(--bad)'
            : probe.startsWith('✗') ? 'var(--bad)' : 'var(--dim)' }}>{probe}</span>}
      </p>
      {picker}
      <Moves dock={dock} online={online} />
      <div className="grid">
        {Object.entries(profile.body.parts).map(([part, spec]) => (
          <PartControl key={`${dock}/${part}`} dock={dock} part={part} spec={spec} state={state[part] ?? {}} />
        ))}
      </div>
    </section>
  );
}

/**
 * A choreographed move = a list of steps in the brain's `move` vocabulary
 * (absolute degrees per joint, duration + beat in ms). The server's Motion
 * executor runs it (POST /bodylink/play → runSteps), so it heartbeats and
 * one move supersedes the previous — same as the LLM's move tool.
 *
 * Limits the server enforces: neck −60°(up)…+35°(down), foot ±90° swivel.
 * (+neck = nod down, −neck = look up.) We stay inside them so nothing clamps.
 */
type Step = { part?: string; degrees?: number; parts?: Array<{ part: string; degrees: number }>; duration_ms?: number; wait_ms?: number; snap?: boolean };

const HOME: Step = { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 400 };

const MOVES: Array<{ id: string; label: string; emoji: string; len: 'short' | 'long'; steps: Step[] }> = [
  {
    id: 'yes', label: 'Nod Yes', emoji: '👍', len: 'short',
    steps: [
      { part: 'neck', degrees: 30, duration_ms: 200 },
      { part: 'neck', degrees: -10, duration_ms: 200 },
      { part: 'neck', degrees: 30, duration_ms: 200 },
      { part: 'neck', degrees: 0, duration_ms: 250 },
    ],
  },
  {
    id: 'no', label: 'Shake No', emoji: '🙅', len: 'short',
    steps: [
      { part: 'foot', degrees: -35, duration_ms: 180 },
      { part: 'foot', degrees: 35, duration_ms: 220 },
      { part: 'foot', degrees: -30, duration_ms: 200 },
      { part: 'foot', degrees: 30, duration_ms: 200 },
      { part: 'foot', degrees: 0, duration_ms: 250 },
    ],
  },
  {
    id: 'shocked', label: 'Shocked', emoji: '😱', len: 'short',
    steps: [
      // snap up + recoil to the side, FREEZE, then a slow shaken settle
      { parts: [{ part: 'neck', degrees: -55 }, { part: 'foot', degrees: 45 }], duration_ms: 120, wait_ms: 600, snap: true },
      { part: 'foot', degrees: 25, duration_ms: 150 },
      { part: 'foot', degrees: 45, duration_ms: 150, wait_ms: 300 },
      { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 600 },
    ],
  },
  {
    id: 'curious', label: 'Curious', emoji: '🤔', len: 'long',
    steps: [
      // cock head up, slow scan one way, pause, scan back, peer in close
      { part: 'neck', degrees: -25, duration_ms: 400, wait_ms: 200 },
      { part: 'foot', degrees: -40, duration_ms: 700, wait_ms: 400 },
      { part: 'foot', degrees: 40, duration_ms: 900, wait_ms: 400 },
      { part: 'foot', degrees: 0, duration_ms: 500 },
      { part: 'neck', degrees: 20, duration_ms: 400, wait_ms: 500 },
      { part: 'neck', degrees: 0, duration_ms: 400 },
    ],
  },
  {
    id: 'happy', label: 'Happy Dance', emoji: '🥳', len: 'long',
    steps: [
      // bouncy nods while swiveling side to side, building, then a flourish — the beats
      // are MEANT to be punchy, so they snap past the comfortable floor (still cap-bounded)
      { parts: [{ part: 'neck', degrees: 25 }, { part: 'foot', degrees: -30 }], duration_ms: 220, snap: true },
      { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: 30 }], duration_ms: 220, snap: true },
      { parts: [{ part: 'neck', degrees: 25 }, { part: 'foot', degrees: -30 }], duration_ms: 220, snap: true },
      { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: 30 }], duration_ms: 220, snap: true },
      { parts: [{ part: 'neck', degrees: 25 }, { part: 'foot', degrees: -45 }], duration_ms: 180, snap: true },
      { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: 45 }], duration_ms: 180, snap: true },
      { parts: [{ part: 'neck', degrees: 25 }, { part: 'foot', degrees: -45 }], duration_ms: 180, snap: true },
      { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: 45 }], duration_ms: 180, snap: true },
      // spin-out flourish: full swivel, look up, settle home
      { part: 'foot', degrees: 80, duration_ms: 350 },
      { part: 'foot', degrees: -80, duration_ms: 500 },
      { parts: [{ part: 'neck', degrees: -30 }, { part: 'foot', degrees: 0 }], duration_ms: 300, wait_ms: 200 },
      { part: 'neck', degrees: 0, duration_ms: 300 },
    ],
  },
  {
    id: 'sad', label: 'Sad', emoji: '😔', len: 'long',
    steps: [
      // head droops down slowly, hangs low, slow heavy sway, stays down
      { part: 'neck', degrees: 35, duration_ms: 1200, wait_ms: 600 },
      { part: 'foot', degrees: -20, duration_ms: 1000 },
      { part: 'foot', degrees: 20, duration_ms: 1400 },
      { part: 'foot', degrees: 0, duration_ms: 1000, wait_ms: 800 },
      { part: 'neck', degrees: 28, duration_ms: 700 },
    ],
  },
  {
    id: 'confused', label: 'Confused', emoji: '😵‍💫', len: 'short',
    steps: [
      // head tilts up one way, snaps the other, double-takes, can't make sense of it
      { parts: [{ part: 'neck', degrees: -20 }, { part: 'foot', degrees: -30 }], duration_ms: 350, wait_ms: 250 },
      { parts: [{ part: 'neck', degrees: -28 }, { part: 'foot', degrees: 35 }], duration_ms: 300, wait_ms: 250 },
      { part: 'foot', degrees: -25, duration_ms: 250 },
      { part: 'foot', degrees: 25, duration_ms: 250, wait_ms: 200 },
      // a little "huh?" jerk up, then a slow puzzled settle
      { part: 'neck', degrees: -35, duration_ms: 150, wait_ms: 400 },
      { parts: [{ part: 'neck', degrees: -8 }, { part: 'foot', degrees: 0 }], duration_ms: 500 },
    ],
  },
  {
    id: 'studying', label: 'Studying', emoji: '📖', len: 'long',
    steps: [
      // bend down to the book and stay down — just keep reading the page,
      // eyes tracking left→right→left→right for a good while.
      { part: 'neck', degrees: 35, duration_ms: 900, wait_ms: 400 },
      { part: 'foot', degrees: -25, duration_ms: 800, wait_ms: 250 },
      { part: 'foot', degrees: 25, duration_ms: 1000, wait_ms: 250 },
      { part: 'foot', degrees: -25, duration_ms: 1000, wait_ms: 250 },
      { part: 'foot', degrees: 25, duration_ms: 1000, wait_ms: 250 },
      { part: 'foot', degrees: -22, duration_ms: 900, wait_ms: 300 },
      { part: 'foot', degrees: 22, duration_ms: 900, wait_ms: 300 },
      { part: 'foot', degrees: -18, duration_ms: 900, wait_ms: 400 },
      { part: 'foot', degrees: 0, duration_ms: 700 },
    ],
  },
  {
    id: 'coaster', label: 'Roller Coaster', emoji: '🎢', len: 'long',
    steps: [
      // 1) slow click-click climb up the lift hill — tilt back, look up
      { parts: [{ part: 'neck', degrees: -45 }, { part: 'foot', degrees: 0 }], duration_ms: 1400, wait_ms: 250 },
      // 2) hang at the crest, peek over the edge...
      { part: 'neck', degrees: 10, duration_ms: 400, wait_ms: 350 },
      // 3) THE DROP — slam forward and down
      { part: 'neck', degrees: 35, duration_ms: 250, wait_ms: 150 },
      // 4) bottom of the drop, whip into a hard right turn
      { parts: [{ part: 'neck', degrees: 5 }, { part: 'foot', degrees: 75 }], duration_ms: 300 },
      // 5) snap back through a left turn
      { parts: [{ part: 'neck', degrees: 5 }, { part: 'foot', degrees: -75 }], duration_ms: 350 },
      // 6) airtime hop up
      { parts: [{ part: 'neck', degrees: -30 }, { part: 'foot', degrees: 0 }], duration_ms: 200 },
      // 7) and back down, banking right
      { parts: [{ part: 'neck', degrees: 30 }, { part: 'foot', degrees: 55 }], duration_ms: 250 },
      // 8) quick rattly left-right-left through the last turns
      { part: 'foot', degrees: -50, duration_ms: 200 },
      { part: 'foot', degrees: 40, duration_ms: 200 },
      // 9) coast to a stop, settle home
      { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 600 },
    ],
  },
  {
    id: 'bullied', label: 'Bullied', emoji: '🥺', len: 'long',
    steps: [
      // 1) turns hopefully toward the others, looking up to be included
      { parts: [{ part: 'neck', degrees: -25 }, { part: 'foot', degrees: -40 }], duration_ms: 600, wait_ms: 300 },
      // 2) leans in eagerly... but they ignore it
      { part: 'foot', degrees: -55, duration_ms: 400, wait_ms: 600 },
      // 3) turns the other way hoping someone else will include it
      { parts: [{ part: 'neck', degrees: -20 }, { part: 'foot', degrees: 45 }], duration_ms: 600, wait_ms: 700 },
      // 4) a shove — knocked sharply aside, head jolts
      { parts: [{ part: 'neck', degrees: 15 }, { part: 'foot', degrees: 80 }], duration_ms: 150, wait_ms: 200 },
      // 5) flinch/recoil away from them, pulls back small
      { parts: [{ part: 'neck', degrees: 25 }, { part: 'foot', degrees: 30 }], duration_ms: 350, wait_ms: 400 },
      // 6) one last small hopeful glance up... left alone
      { parts: [{ part: 'neck', degrees: -8 }, { part: 'foot', degrees: 0 }], duration_ms: 700, wait_ms: 800 },
      // 7) it sinks in — head droops all the way down, turns away
      { parts: [{ part: 'neck', degrees: 35 }, { part: 'foot', degrees: -20 }], duration_ms: 1600, wait_ms: 700 },
      // 8) a slow, heavy, sad little sway — hangs there low
      { part: 'foot', degrees: 15, duration_ms: 1400 },
      { part: 'foot', degrees: -10, duration_ms: 1200, wait_ms: 600 },
      { parts: [{ part: 'neck', degrees: 33 }, { part: 'foot', degrees: 0 }], duration_ms: 800 },
    ],
  },
  {
    id: 'attitude', label: 'Attitude', emoji: '💅', len: 'long',
    steps: [
      // 1) sharp head-snap to face them, chin up — "excuse me?"
      { parts: [{ part: 'neck', degrees: -25 }, { part: 'foot', degrees: 30 }], duration_ms: 180, wait_ms: 400 },
      // 2) slow look-you-up-and-down: down...
      { part: 'neck', degrees: 25, duration_ms: 500 },
      // 3) ...and back up, unimpressed
      { part: 'neck', degrees: -30, duration_ms: 600, wait_ms: 450 },
      // 4) sassy head bob/wobble while "telling you off"
      { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: 20 }], duration_ms: 200 },
      { parts: [{ part: 'neck', degrees: -22 }, { part: 'foot', degrees: -15 }], duration_ms: 200 },
      { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: 20 }], duration_ms: 200 },
      { parts: [{ part: 'neck', degrees: -22 }, { part: 'foot', degrees: -15 }], duration_ms: 200, wait_ms: 300 },
      // 5) dismissive turn-AWAY — "talk to the hand", nose in the air
      { parts: [{ part: 'neck', degrees: -45 }, { part: 'foot', degrees: -80 }], duration_ms: 350, wait_ms: 700 },
      // 6) a single side-eye flick back at them...
      { part: 'foot', degrees: -55, duration_ms: 250, wait_ms: 500 },
      // 7) ...nope. chin right back up, hold the cocky pose
      { parts: [{ part: 'neck', degrees: -40 }, { part: 'foot', degrees: -70 }], duration_ms: 300, wait_ms: 600 },
    ],
  },
];

function Moves({ dock, online }: { dock: string; online: boolean }) {
  const [running, setRunning] = useState<string | null>(null);

  const play = (id: string, steps: Step[]) => {
    setRunning(id);
    api.post('/bodylink/play', { dock, steps })
      .catch(() => {})
      .finally(() => setTimeout(() => setRunning((r) => (r === id ? null : r)), 1200));
  };
  const stop = () => { setRunning(null); api.post('/bodylink/play', { dock, steps: [HOME] }).catch(() => {}); };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Moves <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· choreographed sequences (server-run)</span></h3>
      {!online && <div className="muted" style={{ marginBottom: 8 }}>body offline — moves won't reach the servos.</div>}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {MOVES.map((m) => (
          <button key={m.id} onClick={() => play(m.id, m.steps)} disabled={!online}
            title={`${m.len} · ${m.steps.length} steps`}
            style={running === m.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}>
            {m.emoji} {m.label}
            <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>{m.len}</span>
          </button>
        ))}
        <div className="spacer" />
        <button onClick={stop} disabled={!online}>⏹ Home</button>
      </div>
    </div>
  );
}

function PartControl({ dock, part, spec, state }: { dock: string; part: string; spec: PartSpec; state: Record<string, number> }) {
  const main = 'pulse_width_us' in spec.params ? 'pulse_width_us' : Object.keys(spec.params)[0]!;
  const ps = spec.params[main]!;
  const lo = ps.range[0] ?? 0;
  const hi = ps.range[1] ?? 4000;
  const home = spec.home?.[main] ?? Math.round((lo + hi) / 2);
  const angles = main === 'pulse_width_us' && hasAngle(part);

  // `val` = what the CONSOLE last COMMANDED (not the live reported state, which
  // drifts as the executor heartbeats the body). Start at home so a fresh load
  // is deterministic — 0° for an angle part — instead of capturing a moving report.
  const [val, setVal] = useState<number>(home);

  // The brain's LIMIT for this part — shown for reference (asymmetric: min,max).
  // The console is NOT bound by it (drive past it to calibrate the real stop).
  // NOTE: duplicated from the brain's DEGREE_LIMITS for now — shared store later.
  const [limitLoDeg, limitHiDeg] = angles ? DEGREE_RANGE[part]! : [0, 0];
  const limitLoUs = angles ? degreesToUs(part, limitLoDeg) : lo; // brain-limit endpoints in µs
  const limitHiUs = angles ? degreesToUs(part, limitHiDeg) : hi;

  // Console degree↔µs uses the FIXED ±90° scale with NO brain-limit clamp, so
  // the +/- buttons can drive past the limit (only the servo's µs bounds apply).
  const FULL = 90;
  const usToDegRaw = (us: number) => Math.round(((us - 1500) / 1000) * FULL * 10) / 10;
  const degToUsRaw = (deg: number) => Math.round(1500 + (deg / FULL) * 1000);

  const cmdDeg = angles ? usToDegRaw(val) : null;
  const reportedUs = state[main];
  const reportedDeg = angles && reportedUs != null ? usToDegRaw(reportedUs) : null;
  const fmtDeg = (d: number | null) => (d == null ? '' : `${d > 0 ? '+' : ''}${d}°`);

  const send = (v: number, durationMs = 400) => {
    // Console drives the FULL hardware range — only the servo's µs bounds clamp.
    const clamped = Math.max(lo, Math.min(hi, Math.round(v)));
    setVal(clamped);
    api.post('/bodylink/command', { dock, parts: { [part]: { [main]: clamped, duration_ms: durationMs } } }).catch(() => {});
  };
  /** nudge by ±µs for fine calibration toward a gear stop. */
  const nudge = (d: number) => send(val + d);
  /** step by ±N degrees on the full ±90° scale (NOT clamped to the brain limit). */
  const nudgeDeg = (d: number) => send(degToUsRaw((usToDegRaw(val)) + d));

  return (
    <div className="card">
      <h3>{part}{angles && <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> · brain limit {limitLoDeg}°…+{limitHiDeg}°</span>}</h3>
      {spec.description && <div className="muted" style={{ marginBottom: 8 }}>{spec.description}</div>}
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="muted">{main} ({ps.unit})</span>
        <div className="spacer" />
        <span className="mono">
          cmd {val}
          {angles && (
            <b style={{ color: (cmdDeg ?? 0) < limitLoDeg || (cmdDeg ?? 0) > limitHiDeg ? 'var(--warn)' : 'var(--accent)' }}> {fmtDeg(cmdDeg)}</b>
          )}
        </span>
        <span className="muted mono">· reported {reportedUs ?? '—'}{reportedDeg != null && ` ${fmtDeg(reportedDeg)}`}</span>
      </div>
      <input type="range" min={lo} max={hi} value={val} style={{ width: '100%' }}
        onChange={(e) => setVal(Number(e.target.value))}
        onMouseUp={(e) => send(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => send(Number((e.target as HTMLInputElement).value))} />
      <div className="row" style={{ marginTop: 10 }}>
        {/* min/max jump to the BRAIN LIMIT (the LLM's range). Use the slider or
            the +/- buttons to go PAST it for calibration. */}
        <button onClick={() => send(limitLoUs)}>min{angles && ` ${fmtDeg(limitLoDeg)}`}</button>
        <button onClick={() => send(home)}>home 0°</button>
        <button onClick={() => send(limitHiUs)}>max{angles && ` ${fmtDeg(limitHiDeg)}`}</button>
      </div>
      {angles && (
        <div className="row" style={{ marginTop: 8, gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>step °:</span>
          <button onClick={() => nudgeDeg(-10)}>−10°</button>
          <button onClick={() => nudgeDeg(-5)}>−5°</button>
          <button onClick={() => nudgeDeg(-1)}>−1°</button>
          <button onClick={() => nudgeDeg(+1)}>+1°</button>
          <button onClick={() => nudgeDeg(+5)}>+5°</button>
          <button onClick={() => nudgeDeg(+10)}>+10°</button>
        </div>
      )}
      {angles && (
        <div className="row" style={{ marginTop: 8, gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>raw µs:</span>
          <button onClick={() => nudge(-50)}>−50</button>
          <button onClick={() => nudge(-10)}>−10</button>
          <button onClick={() => nudge(+10)}>+10</button>
          <button onClick={() => nudge(+50)}>+50</button>
        </div>
      )}
    </div>
  );
}
