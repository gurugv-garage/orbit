import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useDocks, useNow, relTime } from '../lib/useDocks';
import type { TaskInstance, TaskState } from '../lib/protocol';

/**
 * Tasks console (docs/TASKS_V1.md) — every background task INSTANCE across all
 * docks: which are still running, how long each has run, the parent session it's
 * tied to, its params, and (on expand) its live status, log tail, and source.
 *
 * Tasks used to leak into the Overview Docks grid as `task:<id>` components; they
 * don't belong there (they're transient jobs, not dock composition). This is their
 * home — driven by GET /api/brain/:dock/instances.
 */

const LIVE: ReadonlySet<TaskState> = new Set<TaskState>(['running', 'stuck']);

const STATE_CLASS: Record<TaskState, string> = {
  running: 'good',
  stuck: 'warn',
  done: 'acc',
  errored: 'bad',
  stopped: '', // plain neutral pill (the base .pill border is already muted)
};

export function Tasks() {
  const docks = useDocks();
  const now = useNow();
  const [byDock, setByDock] = useState<Record<string, TaskInstance[]>>({});
  const [liveOnly, setLiveOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const dockNames = docks.map((d) => d.name).join(',');

  const refresh = useCallback(async () => {
    const names = dockNames ? dockNames.split(',') : [];
    const results = await Promise.all(
      names.map((d) =>
        api.get<TaskInstance[]>(`/brain/${encodeURIComponent(d)}/instances`)
          .then((list) => [d, list] as const)
          .catch(() => [d, [] as TaskInstance[]] as const)),
    );
    setByDock(Object.fromEntries(results));
  }, [dockNames]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // newest-first; live tasks float to the top regardless of age.
  const all = Object.values(byDock).flat()
    .filter((i) => !liveOnly || LIVE.has(i.state))
    .sort((a, b) => Number(LIVE.has(b.state)) - Number(LIVE.has(a.state)) || b.startedAt - a.startedAt);

  const liveCount = Object.values(byDock).flat().filter((i) => LIVE.has(i.state)).length;
  const total = Object.values(byDock).flat().length;

  return (
    <section>
      <h2 className="title">Tasks</h2>
      <p className="subtitle">
        Background jobs the dock brain runs as separate processes (<code>docs/TASKS_V1.md</code>).
        Each instance is its own process tied to the session that spawned it.
      </p>

      <div className="grid">
        <div className="card"><h3>Running now</h3><div className="stat">{liveCount}</div><div className="muted">running · stuck</div></div>
        <div className="card"><h3>Known instances</h3><div className="stat">{total}</div><div className="muted">across {docks.length} dock{docks.length === 1 ? '' : 's'}</div></div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Instances</h3>
          <div className="spacer" />
          <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
            running only
          </label>
        </div>
        {all.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            {total === 0 ? 'No tasks have run yet. The brain starts one when you ask it to (e.g. "remind me in 10 minutes…").' : 'No running tasks. Untick "running only" to see finished ones.'}
          </div>
        ) : (
          <div className="feed" style={{ marginTop: 8 }}>
            {all.map((i) => (
              <TaskRow
                key={i.instanceId} t={i} now={now}
                expanded={open === i.instanceId}
                onToggle={() => setOpen(open === i.instanceId ? null : i.instanceId)}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TaskRow({ t, now, expanded, onToggle, onChanged }: {
  t: TaskInstance; now: number; expanded: boolean; onToggle: () => void; onChanged: () => void;
}) {
  const live = LIVE.has(t.state);
  const params = Object.entries(t.params).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
      <div className="row" style={{ alignItems: 'baseline', cursor: 'pointer' }} onClick={onToggle}>
        <span className="muted" style={{ width: 12 }}>{expanded ? '▾' : '▸'}</span>
        <b>{t.name}</b>
        <span className="mono muted">{t.instanceId}</span>
        <span className={`pill ${STATE_CLASS[t.state]}`} style={{ fontSize: 10 }}>{t.state}</span>
        <span className="muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {params}
        </span>
        <span className="muted mono" style={{ fontSize: 11 }} title={new Date(t.startedAt).toLocaleString()}>
          {live ? `up ${fmtDuration(now - t.startedAt)}` : `ran ${relTime(t.startedAt, now)}`}
        </span>
      </div>
      {expanded && <TaskDetail t={t} now={now} onChanged={onChanged} />}
    </div>
  );
}

function TaskDetail({ t, now, onChanged }: { t: TaskInstance; now: number; onChanged: () => void }) {
  const [tab, setTab] = useState<'logs' | 'source'>('logs');
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const live = LIVE.has(t.state);
  const base = `/brain/${encodeURIComponent(t.dock)}/instances/${encodeURIComponent(t.instanceId)}`;

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      api.get<{ log: string }>(`${base}/logs`).then((r) => !cancelled && setLogs(r.log ?? '')).catch(() => {});
      api.get<{ status: string }>(`${base}/status`).then((r) => !cancelled && setStatus(r.status ?? '')).catch(() => {});
    };
    pull();
    // keep logs/status fresh while a task is live; one-shot for terminal ones.
    const iv = live ? setInterval(pull, 2000) : undefined;
    return () => { cancelled = true; if (iv) clearInterval(iv); };
  }, [base, live]);

  useEffect(() => {
    if (tab !== 'source' || source) return;
    api.get<{ source: string }>(`${base}/source`).then((r) => setSource(r.source ?? '')).catch(() => setSource('(source unavailable)'));
  }, [tab, base, source]);

  const act = (op: 'stop' | 'restart' | 'resume') => {
    api.post(`${base}/${op}`, {}).then(onChanged).catch(() => {});
  };

  return (
    <div style={{ marginLeft: 18, marginTop: 8 }}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        <Field label="session" value={t.parentSessionId} mono />
        <Field label="started" value={new Date(t.startedAt).toLocaleString()} />
        <Field label="duration" value={live ? fmtDuration(now - t.startedAt) : '—'} />
        <Field label="runs" value={String(t.runCount)} />
        <Field label="dock" value={t.dock} />
      </div>

      {status && <div className="muted mono" style={{ fontSize: 12, margin: '8px 0' }}>status: {status}</div>}
      {t.lastSignal && <div className="muted mono" style={{ fontSize: 12, marginBottom: 8 }}>last: {t.lastSignal}</div>}

      <div className="row" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>logs</button>
        <button className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}>source</button>
        <div className="spacer" />
        {live && <button onClick={() => act('stop')}>stop</button>}
        {live ? <button onClick={() => act('restart')}>restart</button>
              : (t.state === 'stopped' && <button onClick={() => act('resume')}>resume</button>)}
      </div>

      <pre style={{
        background: 'var(--bg2, #0b0e17)', border: '1px solid var(--line)', borderRadius: 6,
        padding: 10, fontSize: 12, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap',
        margin: 0, fontFamily: 'monospace',
      }}>
        {tab === 'logs' ? (logs || '(no log output yet)') : (source || '(loading…)')}
      </pre>
      {tab === 'source' && <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{t.filePath}</div>}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div className={mono ? 'mono' : undefined} style={{ fontSize: 12, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
