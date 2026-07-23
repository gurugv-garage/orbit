/**
 * Timeline — the cross-component conversation debugger.
 *
 * One chronological view of everything the pipeline decided on a dock:
 * conv_events from all four lanes (phone client-evt, perception STT gates,
 * brain addressed/barge verdicts, conversation-state transitions) laid out as
 * swimlane columns on a shared vertical time axis, with brain turns spanning
 * the lanes where they ran. Utterance rows show BOTH clocks: the audio span
 * (when the sound happened) and the STT lag (+Nms until the transcript landed).
 * Gate deaths (voiced-fraction / min-utterance / withheld) are flagged and,
 * when the clip was kept, playable — hear exactly what was dropped.
 *
 * "⬇ bundle" downloads the same window as the incident markdown
 * (GET /api/observability/incident?format=md) — the paste-to-an-LLM artifact.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './timeline.css';

export interface ConvEvent {
  id: number; ts: number; dockId: string;
  lane: 'phone' | 'perception' | 'brain' | 'conv';
  type: string; verdict?: string; text?: string;
  utteranceId?: string; turnId?: string;
  audioStartAt?: number; audioEndAt?: number; sttFinalAt?: number; deviceTs?: number;
  detail?: Record<string, unknown>;
}
interface IncidentTurn {
  turnId: string; sessionId: string; source: string; startedAt: number; endedAt?: number;
  state?: string; image?: string;
  trigger?: { kind: string; text?: string; via?: string; utteranceId?: string };
  steps: Array<{ index: number; model?: string; ms?: number; error?: string }>;
  speech?: Array<{ startedAt: number; endedAt?: number }>;
}
interface Incident { events: ConvEvent[]; turns: IncidentTurn[] }

const LANES = ['phone', 'perception', 'brain', 'conv'] as const;
const WINDOWS: Array<[label: string, ms: number]> = [
  ['5m', 5 * 60_000], ['15m', 15 * 60_000], ['1h', 3_600_000], ['6h', 6 * 3_600_000], ['24h', 24 * 3_600_000],
];

export const fmtT = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
  + '.' + String(ms % 1000).padStart(3, '0');

/** verdicts that mean "something was silently eaten" — the rows this view exists for. */
const BAD = new Set(['voiced-fraction', 'min-utterance', 'hallucination', 'beep-artifact',
  'low-conf-backchannel', 'no-words', 'skip:garbage', 'skip:no-words', 'skip:not-addressed',
  'skip:stale', 'skip:dismissed', 'stt:unreachable']);
const GOOD = new Set(['RAN-TURN', 'drain:ran', 'wake', 'wake+command']);

/** Plain-language WHY for a brain verdict — the ✕/✓ must explain itself. */
function explainVerdict(ev: ConvEvent): string | null {
  if (ev.lane !== 'brain' || ev.type !== 'addr') return null;
  const d = ev.detail ?? {};
  switch (ev.verdict) {
    case 'skip:not-addressed': {
      const bits = ['no listening window was open when this utterance was judged — the dock only answers inside a window (tap / palm / wake / the 8s followup after its own reply).'];
      if (d.admitRule === 'ended-before-grace') bits[0] = 'a window WAS open, but the utterance ended more than the 2.5s grace before the final landed.';
      const lastUntil = Number(d.lastWindowUntil ?? 0);
      if (lastUntil > 0 && ev.audioStartAt) {
        const gap = ev.audioStartAt - lastUntil;
        bits.push(gap >= 0
          ? `the last window (opened by ${String(d.windowOpenedBy || '?')}) closed ${(gap / 1000).toFixed(1)}s BEFORE this speech started.`
          : `speech started while a window was open but was rejected by rule ${String(d.admitRule ?? '?')}.`);
      } else if (lastUntil === 0) {
        bits.push('no window had ever been opened (or the last one was consumed/closed by tap-off/dismiss).');
      }
      return bits.join(' ');
    }
    case 'skip:garbage': return 'STT confidence tier = garbage (far-field mush / repetition loop) — words too unreliable to act on.';
    case 'skip:no-words': return 'transcript had <2 alphanumeric characters — no content to act on.';
    case 'skip:quiet': return 'dock is in 🤐 quiet mode — never replies until quiet is lifted.';
    case 'skip:recording': return 'capture harness is recording — responses suppressed for clean ambient perception.';
    case 'queue:busy': return 'dock was mid-reply (thinking/speaking) — queued; runs as one combined turn when the reply settles.';
    case 'drain:ran': return 'queued mid-reply speech, run at settle as a combined turn.';
    case 'skip:stale': return 'queued item was older than 20s at drain time — dropped rather than answered late.';
    case 'skip:dismissed': return 'queue cleared by a stop/dismiss — nothing drains after a stand-down.';
    case 'merge:supersede': return 'heard while THINKING with a window open — aborted the in-flight call and re-asked with this folded in.';
    case 'stop:dismiss': return 'classified as a dismissal — turn aborted, all windows closed, queue cleared.';
    case 'stop:pause': return 'classified as "wait/hold on" — reply aborted, listening window opened, queue kept.';
    case 'barge:hold': return 'speech onset during the reply — TTS paused (polite pause), awaiting the STT final to decide stop vs resume.';
    case 'barge:skip:self-motion': return 'onset ignored: the body moved <1.8s ago (servo noise reads as voice).';
    case 'RAN-TURN': return `admitted: ${String(d.admitRule ?? 'window-open')} via ${String(d.via ?? '?')} (window opened by ${String(d.windowOpenedBy ?? '?')}).`;
    default:
      if (ev.verdict?.startsWith('barge:release:')) {
        const why = ev.verdict.slice('barge:release:'.length);
        return why === 'timeout' ? 'barge hold hit 6s with no clean stop — YIELDED: reply aborted, listening opened.'
          : `barge hold released by decision "${why}" — a non-stop final resumes the reply; a stop kills it.`;
      }
      return null;
  }
}

/** Programmatic-source tag: injected/debug rows must NEVER read as a real human
 *  utterance (recurring confusion — "who said this?"). debug:<ts> utteranceIds
 *  come from the debug REST API; via phone:turn-request = phone-side debug/adb. */
function sourceTag(utteranceId?: string, via?: string): string | null {
  if (utteranceId?.startsWith('debug:')) return 'debug-api';
  if (via === 'phone:turn-request') return 'phone-debug';
  return null;
}

export function EventChip({ ev }: { ev: ConvEvent }) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  const toggleClip = (url: string) => {
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    const a = new Audio(url);
    audioRef.current = a;
    a.onended = () => { setPlaying(false); audioRef.current = null; };
    a.onerror = () => { setPlaying(false); audioRef.current = null; };
    void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  const bad = (ev.verdict && BAD.has(ev.verdict)) || ev.type === 'stt:drop' || ev.type === 'stt:withheld' || ev.type === 'stt:unreachable';
  const good = ev.verdict ? GOOD.has(ev.verdict) : false;
  const sttLag = ev.sttFinalAt && ev.audioEndAt ? ev.sttFinalAt - ev.audioEndAt : undefined;
  const audioMs = ev.audioStartAt && ev.audioEndAt ? ev.audioEndAt - ev.audioStartAt : undefined;
  // dropped/committed clips are keyed by the audio start ms (the WAV filename).
  const clip = (ev.detail?.clip === true || ev.type === 'stt:final') && ev.audioStartAt
    ? `/api/perception/utterance-audio/${encodeURIComponent(ev.dockId)}/${ev.audioStartAt}` : undefined;
  const label = ev.type.replace(/^phone:|^conv:/, '');
  return (
    <span
      className={`tl-ev tl-ev-${ev.lane}${bad ? ' bad' : ''}${good ? ' good' : ''}${open ? ' open' : ''}`}
      title={`${ev.type}${ev.verdict ? ` → ${ev.verdict}` : ''} @ ${fmtT(ev.ts)}${explainVerdict(ev) ? `\n\nWHY: ${explainVerdict(ev)}` : ''}\n(click for detail)`}
      onClick={() => setOpen((o) => !o)}
    >
      {bad ? '✕ ' : good ? '✓ ' : ''}
      <span className="mono">{ev.lane === 'conv' ? `→ ${label}` : label}</span>
      {ev.verdict && ev.verdict !== label && <> <b>{ev.verdict}</b></>}
      {sourceTag(ev.utteranceId) && <span className="tl-srctag" title="not real audio — injected via the debug API">💉 {sourceTag(ev.utteranceId)}</span>}
      {ev.text && <> “{ev.text}”</>}
      {audioMs != null && <span className="tl-lag" title="how long the SOUND lasted">🎙{(audioMs / 1000).toFixed(1)}s</span>}
      {sttLag != null && <span className="tl-lag" title="sound ended → transcript landed (decisions in between saw no text)">stt +{sttLag}ms</span>}
      {ev.deviceTs != null && <span className="tl-lag" title="phone clock vs station arrival">skew {ev.ts - ev.deviceTs}ms</span>}
      {clip && (
        <span className="tl-clip" title={playing ? 'pause' : 'play the actual audio'} role="button"
          onClick={(e) => { e.stopPropagation(); toggleClip(clip); }}>{playing ? '⏸' : '▶'}</span>
      )}
      {open && (
        <span className="tl-detail">
          {explainVerdict(ev) && <span className="tl-why">{explainVerdict(ev)}</span>}
          <span className="mono">
            {ev.utteranceId && <>u:{ev.utteranceId} · </>}
            {ev.audioStartAt && <>audio {fmtT(ev.audioStartAt)}{ev.audioEndAt ? `–${fmtT(ev.audioEndAt)}` : ''} · </>}
            {ev.detail ? JSON.stringify(ev.detail) : null}
          </span>
        </span>
      )}
    </span>
  );
}

function TurnRow({ t }: { t: IncidentTurn }) {
  const dur = t.endedAt ? t.endedAt - t.startedAt : undefined;
  const err = t.steps.some((s) => s.error);
  return (
    <div className="tl-turn" title={t.trigger?.text ?? ''}>
      🧠 <b>turn</b> {t.state ?? 'open'}{err ? ' ⚠' : ''} · {t.trigger?.kind ?? '?'}
      {t.trigger?.via ? ` via ${t.trigger.via}` : ''}
      {sourceTag(t.trigger?.utteranceId, t.trigger?.via) && <span className="tl-srctag" title="programmatic trigger — no real audio behind this turn">💉 {sourceTag(t.trigger?.utteranceId, t.trigger?.via)}</span>}
      {t.trigger?.text ? <> — “{t.trigger.text.slice(0, 140)}”</> : null}
      {dur != null && <span className="tl-lag">{(dur / 1000).toFixed(1)}s</span>}
      {t.speech?.length ? <span className="tl-lag">🔊 {t.speech.length} tts window{t.speech.length > 1 ? 's' : ''}</span> : null}
      {t.image && (
        <a href={`/api/observability/turn-image?f=${encodeURIComponent(t.image)}`} target="_blank" rel="noreferrer"
          title="the input frame the model saw" style={{ marginLeft: 6 }}>📷</a>
      )}
      <a className="tl-lag mono" href={`#observability?session=${encodeURIComponent(t.sessionId)}&turn=${encodeURIComponent(t.turnId)}`}
        title="open this turn expanded in the Observability tree">{t.turnId.slice(0, 13)}… → open in Observability</a>
    </div>
  );
}

export function Timeline() {
  const [dock, setDock] = useState('');
  const [winMs, setWinMs] = useState(15 * 60_000);
  const [live, setLive] = useState(true);
  const [lanes, setLanes] = useState<Set<string>>(new Set(LANES));
  const [data, setData] = useState<Incident>({ events: [], turns: [] });
  const [frozenTo, setFrozenTo] = useState<number | null>(null); // pause = pin the window

  const to = frozenTo ?? Date.now();
  const from = to - winMs;

  // deep link: #timeline?dock=<d>&t=<epochMs> — jump to a moment (from the
  // Observability turn view), frozen so the 3s live refresh doesn't scroll away.
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const d = q.get('dock'); const t = Number(q.get('t'));
    if (d) setDock(d);
    if (Number.isFinite(t) && t > 0) { setLive(false); setFrozenTo(t + 120_000); setWinMs(5 * 60_000); }
  }, []);

  const refresh = useCallback(() => {
    const end = frozenTo ?? Date.now();
    const q = new URLSearchParams({ from: String(end - winMs), to: String(end) });
    if (dock) q.set('dock', dock);
    fetch(`/api/observability/incident?${q}`)
      .then((r) => r.json())
      .then((j: Incident) => setData({ events: j.events ?? [], turns: j.turns ?? [] }))
      .catch(() => {});
  }, [dock, winMs, frozenTo]);

  useEffect(() => {
    refresh();
    if (!live) return;
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, [refresh, live]);

  const docks = useMemo(() => [...new Set(data.events.map((e) => e.dockId))].sort(), [data.events]);

  // merged chronology: events + turn markers, then rendered as grid rows.
  // Each event resolves its OWNING turn (trigger utteranceId match, explicit
  // turnId, or falling inside the turn's [start, settled] span) so a row can
  // show it belongs to a turn instead of floating context-free.
  type Row = { ts: number; ev?: ConvEvent; turn?: IncidentTurn; inTurn?: IncidentTurn; noise?: ConvEvent[]; utt?: ConvEvent[] };
  const rows = useMemo(() => {
    const evs = data.events.filter((e) => lanes.has(e.lane) && (!dock || e.dockId === dock));
    const turns = data.turns.filter((t) => !dock || t.source === dock);
    const byUtt = new Map(turns.filter((t) => t.trigger?.utteranceId).map((t) => [t.trigger!.utteranceId!, t]));
    const owner = (e: ConvEvent): IncidentTurn | undefined => {
      if (e.utteranceId && byUtt.has(e.utteranceId)) return byUtt.get(e.utteranceId);
      if (e.turnId) return turns.find((t) => t.turnId === e.turnId);
      // fall inside the turn's active span (settledAt would be better; endedAt + 5s
      // covers the TTS tail for span-only membership).
      return turns.find((t) => e.ts >= t.startedAt && e.ts <= (t.endedAt ?? t.startedAt) + 5000);
    };
    // UTTERANCE JOURNEYS: all events sharing an utteranceId collapse into ONE
    // row (audio → stt verdict → brain verdict → turn) — the correlation is the
    // point; scattered chips sharing an invisible id were unreadable.
    const byId = new Map<string, ConvEvent[]>();
    const loose: ConvEvent[] = [];
    for (const e of evs) {
      if (e.utteranceId) {
        const l = byId.get(e.utteranceId);
        if (l) l.push(e); else byId.set(e.utteranceId, [e]);
      } else loose.push(e);
    }
    const all: Row[] = [
      ...loose.map((ev) => ({ ts: ev.ts, ev, inTurn: owner(ev) })),
      ...[...byId.values()].map((utt) => ({
        ts: Math.min(...utt.map((e) => e.audioStartAt ?? e.ts)),
        utt, inTurn: utt.map(owner).find(Boolean),
      })),
      ...turns.map((turn) => ({ ts: turn.startedAt, turn })),
    ].sort((a, z) => a.ts - z.ts);
    // COLLAPSE ambient noise: runs of >=3 consecutive no-text perception drops
    // outside any turn fold into one expandable row — otherwise the ~4/min
    // ambient voiced-fraction drops drown everything that matters.
    const isNoise = (r: Row) => {
      const es = r.ev ? [r.ev] : r.utt;
      return !!es && !r.inTurn && es.every((e) => !e.text && (e.type === 'stt:drop' || e.type === 'stt:empty'));
    };
    const out: Row[] = [];
    for (let i = 0; i < all.length;) {
      let j = i;
      while (j < all.length && isNoise(all[j]!)) j++;
      if (j - i >= 3) { out.push({ ts: all[i]!.ts, noise: all.slice(i, j).flatMap((r) => r.ev ? [r.ev] : r.utt!) }); i = j; }
      else { out.push(all[i]!); i++; }
    }
    return out.reverse(); // newest first — you're almost always here for "just now"
  }, [data, lanes, dock]);

  const mdUrl = `/api/observability/incident?${new URLSearchParams({
    from: String(from), to: String(to), format: 'md', ...(dock ? { dock } : {}),
  })}`;

  return (
    <section>
      <h2>🧵 Timeline</h2>
      <p className="muted sm">
        Every conversational decision, every component, one clock. ✕ rows are utterances/gates that were
        silently eaten before this view existed. 🎙 = how long the sound lasted; “stt +Nms” = how much later
        the transcript landed — anything the brain decided in that gap saw no text.
      </p>
      <div className="tl-controls">
        <select value={dock} onChange={(e) => setDock(e.target.value)}>
          <option value="">all docks</option>
          {docks.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {WINDOWS.map(([label, ms]) => (
          <button key={label} className={`pill sm${winMs === ms ? ' acc' : ''}`} onClick={() => setWinMs(ms)}>{label}</button>
        ))}
        <button className={`pill sm${live ? ' acc' : ''}`}
          title="live = refresh every 3s; paused pins the current window"
          onClick={() => { setLive((l) => { const nl = !l; setFrozenTo(nl ? null : Date.now()); return nl; }); }}>
          {live ? '⏸ live' : '▶ paused'}
        </button>
        {LANES.map((l) => (
          <label key={l} className="sm" style={{ userSelect: 'none' }}>
            <input type="checkbox" checked={lanes.has(l)}
              onChange={() => setLanes((prev) => {
                const n = new Set(prev); if (n.has(l)) n.delete(l); else n.add(l); return n;
              })} /> {l}
          </label>
        ))}
        <a className="pill sm" href={mdUrl} target="_blank" rel="noreferrer"
          title="the whole window as one markdown incident bundle — paste it to an LLM to debug">⬇ bundle</a>
        <span className="muted sm">{rows.length} rows</span>
      </div>
      <div className="tl-feed">
        {rows.length === 0 && <div className="tl-gap">no events in this window{dock ? ` for ${dock}` : ''}</div>}
        {rows.map((row, i) => {
          // newest-first: the divider shows the quiet stretch between this row
          // and the (newer) one rendered above it.
          const prev = rows[i - 1];
          const gapMs = prev ? prev.ts - row.ts : 0;
          const key = row.ev ? `e${row.ev.id}` : row.noise ? `n${row.noise[0]!.id}`
            : row.utt ? `u${row.utt[0]!.id}` : `t${row.turn!.sessionId}:${row.turn!.turnId}`;
          return <FeedRow key={key} row={row} gapMs={gapMs > 30_000 ? gapMs : 0} />;
        })}
      </div>
    </section>
  );
}

/** A folded run of ambient perception drops — one line, expandable. */
function NoiseRow({ evs }: { evs: ConvEvent[] }) {
  const [open, setOpen] = useState(false);
  const pcts = evs.map((e) => Number(e.detail?.voicedPct)).filter((n) => Number.isFinite(n));
  const spanS = Math.round((evs[evs.length - 1]!.ts - evs[0]!.ts) / 1000);
  return (
    <div className="tl-noise" role="button" onClick={() => setOpen((o) => !o)}
      title="ambient sound the gates dropped (no transcript, outside any turn) — click to expand">
      🔇 {evs.length} ambient drops over {spanS}s
      {pcts.length ? ` (voiced ${Math.min(...pcts)}–${Math.max(...pcts)}%, floor 35%)` : ''} {open ? '▾' : '▸'}
      {open && evs.map((ev) => (
        <div key={ev.id} className="tl-line">
          <span className="tl-time mono">{fmtT(ev.ts)}</span>
          <span className="tl-lanebadge mono">{ev.lane}</span>
          <EventChip ev={ev} />
        </div>
      ))}
    </div>
  );
}

function fmtGap(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** One utterance's whole journey on one line: audio span → stt → brain verdict. */
function UtteranceRow({ evs, inTurn }: { evs: ConvEvent[]; inTurn?: IncidentTurn }) {
  const stt = evs.find((e) => e.lane === 'perception');
  const brain = evs.find((e) => e.lane === 'brain');
  const main = brain ?? stt ?? evs[0]!;
  return (
    <>
      <span className="tl-lanebadge mono lb-perception" title="one spoken utterance's whole journey: audio → STT → brain verdict">🎙 speech</span>
      <EventChip ev={{ ...main, text: main.text ?? stt?.text,
        audioStartAt: stt?.audioStartAt ?? main.audioStartAt, audioEndAt: stt?.audioEndAt ?? main.audioEndAt,
        sttFinalAt: stt?.sttFinalAt ?? main.sttFinalAt,
        detail: { ...(stt?.detail ?? {}), ...(main.detail ?? {}), clip: stt?.detail?.clip ?? (stt?.type === 'stt:final') } }} />
      {stt && brain && <span className="tl-lag" title="perception verdict for the same utterance">stt: {stt.verdict ?? stt.type.replace('stt:', '')}</span>}
      {inTurn && <span className="tl-turnmark" title={`became turn ${inTurn.turnId}`}>🧠 {inTurn.turnId.slice(5, 13)}</span>}
    </>
  );
}

function FeedRow({ row, gapMs }: { row: { ts: number; ev?: ConvEvent; turn?: IncidentTurn; inTurn?: IncidentTurn; noise?: ConvEvent[]; utt?: ConvEvent[] }; gapMs: number }) {
  return (
    <>
      {gapMs > 0 && <div className="tl-gap">— quiet for {fmtGap(gapMs)} —</div>}
      {row.noise ? (
        <NoiseRow evs={row.noise} />
      ) : row.turn ? (
        <div className="tl-line"><span className="tl-time mono">{fmtT(row.ts)}</span><TurnRow t={row.turn} /></div>
      ) : row.utt ? (
        <div className={`tl-line${row.inTurn ? ' tl-inturn' : ''}`}>
          <span className="tl-time mono">{fmtT(row.ts)}</span>
          <UtteranceRow evs={row.utt} inTurn={row.inTurn} />
        </div>
      ) : (
        <div className={`tl-line${row.inTurn ? ' tl-inturn' : ''}`}>
          <span className="tl-time mono">{fmtT(row.ts)}</span>
          <span className={`tl-lanebadge mono lb-${row.ev!.lane}`}>{row.ev!.lane}</span>
          <EventChip ev={row.ev!} />
          {row.inTurn && <span className="tl-turnmark" title={`part of turn ${row.inTurn.turnId} — “${row.inTurn.trigger?.text ?? ''}”`}>🧠 {row.inTurn.turnId.slice(5, 13)}</span>}
        </div>
      )}
    </>
  );
}
