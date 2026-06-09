import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';
import { DEGREE_RANGE, degreesToUs, hasAngle } from '../lib/bodyAngles';

interface ParamSpec { type: string; unit: string; range: [number | null, number | null]; default?: number; }
interface PartSpec { description?: string; home?: Record<string, number>; params: Record<string, ParamSpec>; }
interface Profile { body: { device_id: string; name: string; parts: Record<string, PartSpec> }; }
type BodyState = Record<string, Record<string, number>>;

export function BodyLink() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<BodyState>({});

  const load = useCallback(() => {
    api.get<Profile | { error: string }>('/bodylink/profile').then((p) => setProfile('body' in p ? p : null)).catch(() => {});
    api.get<BodyState>('/bodylink/state').then(setState).catch(() => {});
  }, []);
  useEffect(load, [load]);

  useStationEvents('bodylink', useCallback((e) => {
    if (e.kind === 'profile') setProfile(e.payload as Profile);
    else if (e.kind === 'state') setState(e.payload as BodyState);
    else if (e.kind === 'applied') load();
  }, [load]));

  if (!profile) {
    return (
      <section>
        <h2 className="title">BodyLink Console</h2>
        <p className="subtitle">Drive the body directly, bypassing the dock app.</p>
        <div className="empty">No body connected. Flash/boot the ESP32 (it dials into <code>/ws</code> and sends its profile), or run <code>npm run smoke</code>.</div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="title">BodyLink Console</h2>
      <p className="subtitle">{profile.body.name} · <span className="mono">{profile.body.device_id}</span></p>
      <div className="grid">
        {Object.entries(profile.body.parts).map(([part, spec]) => (
          <PartControl key={part} part={part} spec={spec} state={state[part] ?? {}} />
        ))}
      </div>
    </section>
  );
}

function PartControl({ part, spec, state }: { part: string; spec: PartSpec; state: Record<string, number> }) {
  const main = 'pulse_width_us' in spec.params ? 'pulse_width_us' : Object.keys(spec.params)[0]!;
  const ps = spec.params[main]!;
  const lo = ps.range[0] ?? 0;
  const hi = ps.range[1] ?? 4000;
  const home = spec.home?.[main] ?? Math.round((lo + hi) / 2);
  const angles = main === 'pulse_width_us' && hasAngle(part);

  // `val` = what the CONSOLE last COMMANDED (not the live reported state, which
  // drifts as the phone heartbeats the body). Start at home so a fresh load is
  // deterministic — 0° for an angle part — instead of capturing a moving report.
  const [val, setVal] = useState<number>(home);

  // The brain's LIMIT for this part — shown for reference (asymmetric: min,max).
  // The console is NOT bound by it (drive past it to calibrate the real stop).
  // NOTE: duplicated from the app's DEGREE_LIMITS for now — shared store later.
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
    api.post('/bodylink/command', { parts: { [part]: { [main]: clamped, duration_ms: durationMs } } }).catch(() => {});
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
