/**
 * Brain module — the dock's LLM loop, server-side (docs/decision-traces/server-brain-impl.md).
 *
 * Owns the `agent` topic. One DockBrainSession per dock (lazy). Tenancy rule:
 * a frame's dock is resolved from the SENDER's hello via the roster — never
 * from the payload — so a device can only ever act on its own lane.
 *
 *   phone → station:  transcript (partials pre-warm), turn-request,
 *                     tool-result (handled by RpcBroker), turn-cancel,
 *                     speech-status
 *   station → phone:  tool-call, speak, turn-status, brain-status (directed)
 *
 *   GET    /api/brain/docks                lanes + open session
 *   GET    /api/brain/keystatus            which API key the current model uses
 *   GET    /api/brain/:dock/sessions       session index (incl. summaries)
 *   GET    /api/brain/:dock/history        open session transcript
 *   POST   /api/brain/:dock/session/end    close now (next turn opens fresh)
 *   GET    /api/brain/:dock/skills         installed skills (name+description)
 *   POST   /api/brain/:dock/skills         install a SKILL.md ({ content })
 *   DELETE /api/brain/:dock/skills/:name   remove an installed skill
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { Hub } from '../../core/hub.js';
import { readFileSync } from 'node:fs';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import { getFaceTools, getPerceptionGrounding, getMemoryApi, getGateApi, getTranscriptApi } from '../perception/index.js';
import { isRecording } from '../capture/index.js';
import type { VideoRecorderApi } from '../perception/record/recorder.js';
import { RpcBroker } from './rpc.js';
import { DockBrainSession, type TurnRequest, keyStatusFor } from './session.js';
import { SessionStore } from './store.js';
import { installDockSkill, listDockSkills, removeDockSkill, loadDockSkills } from './skills.js';
import { buildSystemPrompt } from './prompt.js';
import { FILE_TOOLS_PROMPT } from './filetools.js';
import { TaskSupervisor, type InstanceInfo, type SignalKind } from './tasks/supervisor.js';
import { buildTaskTools } from './tasks/tools.js';
import { defaultTasksRoot, userTasksRoot, loadAllTaskDefs, findTaskDef } from './tasks/manager.js';
import { CapabilityBroker } from './tasks/capabilities.js';
import { buildCapabilityRegistry } from './tasks/register-capabilities.js';
import { validateParams } from '../../tasks/_harness/index.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const IDLE_SWEEP_MS = 60_000;
/** How often to re-push the task-digest to live docks so the app HUD self-corrects
 *  even if a per-change push was missed (failproof running-tasks view). */
const DIGEST_SWEEP_MS = 3_000;
/** A face arriving after at least this long with no presence triggers a PROACTIVE
 *  greeting ("haven't seen you in a while") — not on every walk-up, only after a
 *  real absence. Tune via CONV_GREET_ABSENCE_MS. */
const GREET_ABSENCE_MS = Number(process.env.CONV_GREET_ABSENCE_MS ?? 60 * 60_000);

export interface BrainWiring {
  directory: Directory;
  motion: MotionExecutor;
  getHub: () => Hub;
  /** effective config value by key (the shared ConfigStore). */
  config: (key: string) => unknown;
  /** live video recorder (record_video tool). Optional — undefined disables it. */
  recordVideo?: VideoRecorderApi;
}

export function brainModule(w: BrainWiring): StationModule {
  const store = new SessionStore();
  const sessions = new Map<string, DockBrainSession>();
  // Per-dock wall-clock of the last face-presence arrival, for the long-absence
  // proactive greeting (GREET_ABSENCE_MS). Only a gap longer than that greets.
  const lastFaceArrival = new Map<string, number>();
  // Set in init(): simulate a tapped addressed utterance (debug self-test seam).
  let injectAddressed: (dock: string, text: string) => void = () => {};
  const tasksRoot = defaultTasksRoot();
  const userTasks = userTasksRoot();
  const taskRoots = [
    { root: userTasks, source: 'generated' as const }, // generated first, then packaged
    { root: tasksRoot, source: 'packaged' as const },
  ];
  let bus: Bus;
  let rpc: RpcBroker;

  // A task's parent signal (notify / finish / errored / stuck) → an autonomous
  // turn in that dock's conversational session (tasks §7a).
  const onTaskSignal = (dock: string, info: InstanceInfo, kind: SignalKind, ev: { text: string; image?: string }) => {
    // Use the session FACTORY, not sessions.get: after a station restart the
    // in-memory DockBrainSession may not exist yet (it's created lazily on the
    // first turn), but the dock has running tasks + an open session in the store.
    // Without this the task notify was silently dropped → "the reminder didn't
    // speak". The factory creates/returns the live session so the turn injects.
    const s = session(dock);
    const label = kind === 'finish' ? 'finished' : kind === 'errored' ? 'failed' : kind === 'stuck' ? 'needs input' : 'update';
    const text = `[background task ${info.name} (${info.instanceId}) ${label}] ${ev.text}`
      + (kind === 'stuck' ? ` — call provide_input("${info.instanceId}", <answer>) once the user answers.` : '');
    s.enqueueAutonomousTurn({
      turnId: `auto-${randomUUID()}`,
      trigger: { kind: 'task', text },
      ...(ev.image ? { imageBase64: ev.image } : {}),
      expiresAt: Date.now() + 120_000,
      // coalesce back-to-back signals from the SAME instance (notify+finish) into
      // one turn — keeps both messages, avoids the 2nd superseding the 1st's TTS.
      coalesceKey: info.instanceId,
    });
    pushTaskDigest(dock); // refresh the app's running-tasks view on every change
  };

  // push a directed frame DOWN to a task peer, addressed by (dock, component).
  const sendToTask = (dock: string, instanceId: string, kind: string, payload: Record<string, unknown>) => {
    bus.publish({
      topic: 'tasks', kind, payload: { instanceId, ...payload },
      source: 'station', toAddr: { dock, component: `task:${instanceId}` },
    });
  };

  const supervisor = new TaskSupervisor({
    root: store.root,
    stationWsUrl: process.env.STATION_WS ?? `ws://127.0.0.1:${process.env.PORT ?? 8099}/ws`,
    runner: () => (w.config('brainTaskRunner') === 'tmux' ? 'tmux' : 'child'),
    // give every task the dock's model (for the harness vision helper) + the keys
    // already inherited from process.env (.env). No token — local processes.
    extraEnv: () => {
      const m = w.config('brainModel');
      const env: Record<string, string> = {};
      if (typeof m === 'string' && m) env.BRAIN_MODEL = m;
      return env;
    },
    onSignal: onTaskSignal,
    sendToTask,
  });

  // STATION CAPABILITIES a task can invoke over the wire (frame/recognize/move —
  // things needing the station's live in-process state) — a registry of named
  // handlers + a broker that serves `request` frames.
  const capabilities = buildCapabilityRegistry({
    directory: w.directory, motion: w.motion, getFaces: getFaceTools,
  });
  const capBroker = new CapabilityBroker(capabilities, sendToTask);

  // Push a compact TASK DIGEST to a dock's phone (debug surface): the open
  // sessionId + the running task instances. Sent on hello and whenever tasks
  // change (onTaskSignal), so the app can show "what's running" + the session id.
  const pushTaskDigest = (dock: string) => {
    const sessionId = store.openSession(dock)?.sessionId ?? null;
    const tasks = supervisor.list(dock)
      .filter((i) => i.state === 'running' || i.state === 'stuck')
      .map((i) => ({ instanceId: i.instanceId, name: i.name, state: i.state, lastSignal: i.lastSignal ?? null }));
    bus.publish({
      topic: 'agent', kind: 'task-digest',
      payload: { sessionId, tasks },
      source: 'station', toAddr: { dock, component: 'phone' },
    });
  };

  function session(dock: string): DockBrainSession {
    let s = sessions.get(dock);
    if (!s) {
      s = new DockBrainSession(dock, {
        bus, directory: w.directory, rpc, motion: w.motion, store,
        getFaces: getFaceTools, getGrounding: getPerceptionGrounding,
        getMemory: getMemoryApi,
        recordVideo: w.recordVideo, config: w.config,
        log: (line) => console.log(line),
        stopTasksForParent: (d, parentSessionId) => { supervisor.stopForParent(d, parentSessionId); },
        hasRunningTasks: (d, parentSessionId) => supervisor.hasRunningUnder(d, parentSessionId),
        getTaskTools: (d, parentSessionId) => buildTaskTools({
          dock: d, supervisor, tasksRoot, userTasksRoot: userTasks, parentSessionId, config: w.config,
          capabilityAd: capabilities.advertiseFor(d),
        }),
      });
      sessions.set(dock, s);
    }
    return s;
  }

  /** TENANT RESOLUTION: the sender's dock, from its hello — never the payload. */
  function dockOf(peerId: string): string | undefined {
    return w.getHub().roster().find((p) => p.id === peerId)?.dock;
  }

  return {
    name: 'brain',
    topic: 'agent',
    description: 'the dock brain: per-dock pi agent sessions; transcripts up, tool-calls/speak down',

    init(b) {
      bus = b;
      rpc = new RpcBroker(bus, w.directory);

      // PROACTIVE GATE (docs/perception-to-brain.md Phase 5): a raised attention thought
      // becomes a self-thought turn on the dock's session — the SAME autonomous-turn
      // lane as tasks (user turns still win; it defers while listening/speaking). This
      // is the auto-raise replacement for the console's manual think-poke.
      getGateApi()?.onRaise((t) => {
        if (isRecording(t.dockId)) return; // recording mode → dock stays silent
        session(t.dockId).enqueueAutonomousTurn({
          turnId: `self-${randomUUID()}`,
          trigger: { kind: 'self', text: t.text },
          expiresAt: Date.now() + 30_000,
          coalesceKey: t.key, // dedup same-kind raises (e.g. 'arrival:guru')
        });
      });

      // ADDRESSED TRANSCRIPT → TURN (A1.2, always-on-mic shift). The server STT
      // hears EVERY utterance; a dock tap marks intent ("talking TO me"). Per dock
      // we hold an addressed latch (tapped by the `addressed` agent frame below);
      // when a final utterance qualifies (overlaps/follows the tap), it becomes a
      // user turn-request. The latch clears at sentence-end (one tap → one turn).
      // Overheard (un-tapped) speech is ignored here — only the attention gate may
      // act on it (A1.5). See addressed.ts for the pure correlation + tests.
      // A finalized utterance → ask the dock's conversation state if it's ADDRESSED
      // (an open listening/followup window); if so, run it as a turn. The addressed
      // decision now lives in the session's ConversationState (single owner) — no
      // separate latch Map. Overheard utterances are ignored here (still transcribed
      // upstream; the attention gate may act on them later).
      const onAddressedFinal = (t: { dockId: string; text: string; startedAt: number; endedAt: number; confTier?: string }) => {
        // RECORDING MODE: while this dock is being recorded for the capture harness,
        // the dock must NOT respond (we want clean ambient perception). The mic/cam
        // keep capturing + transcribing upstream; we just don't turn it into a reply.
        if (isRecording(t.dockId)) return;
        // GARBAGE STT: a far-field-mush / repetition-loop transcript must not become a
        // confident agent turn (we'd reply to words that were never said). The snapshot
        // is still kept (tagged) upstream; we just don't act on it. Shaky still runs —
        // a quiet "yes"/"ok" you addressed should work.
        if (t.confTier === 'garbage') return;
        if (!session(t.dockId).utteranceAddressed(t.endedAt)) return;
        void session(t.dockId).handleTurnRequest({
          turnId: `addr-${randomUUID()}`,
          trigger: { kind: 'user', text: t.text },
          stationOriginated: true, // A1.2: the phone must ADOPT this (it didn't start it)
        }).catch((err) => console.error(`[brain] ${t.dockId}: addressed turn crashed`, err));
      };
      // Debug self-test: tap (open the window) then feed a final utterance → a turn
      // always fires. Drives the REAL addressed→turn→adopt path with NO live mic.
      injectAddressed = (dock, text) => {
        session(dock).tap();
        onAddressedFinal({ dockId: dock, text, startedAt: Date.now(), endedAt: Date.now() });
      };
      getTranscriptApi()?.onFinal((t) => { onAddressedFinal(t); });

      bus.on('agent', (msg) => {
        if (msg.source === 'station') return;
        const dock = dockOf(msg.source);
        if (!dock) {
          bus.publish({
            topic: 'agent', kind: 'error',
            payload: { message: 'agent frames need a dock identity (hello.dock)' },
            source: 'station', to: msg.source,
          });
          return;
        }
        const p = msg.payload as Record<string, unknown> | null;
        switch (msg.kind) {
          case 'hello':
            // A (re)connecting phone → reconcile conversation state to idle (clears
            // anything a frame lost across a disconnect would have wedged), then
            // re-send the current mode so the phone (a pure renderer with no state
            // of its own) shows the right thing immediately.
            session(dock).notePhoneConnected();
            session(dock).resendConversation();
            // The deterministic half of the resync handshake: the peer-joined
            // push below can RACE the peer's subscribe frame (both arrive
            // back-to-back; the directed reply fans out before the topic
            // registration lands) — so the phone also says hello on the agent
            // topic AFTER subscribing, and this reply can't miss.
            bus.publish({
              topic: 'agent', kind: 'brain-status',
              payload: { ready: true, activeTurnId: null, sessionId: store.openSession(dock)?.sessionId ?? null },
              source: 'station', to: msg.source,
            });
            pushTaskDigest(dock); // seed the app's running-tasks view on connect
            break;
          case 'transcript':
            if (p?.isFinal !== true) session(dock).preWarm();
            break;
          case 'turn-request':
            void session(dock).handleTurnRequest(p as unknown as TurnRequest).catch((err) => {
              console.error(`[brain] ${dock}: turn crashed`, err);
            });
            break;
          case 'addressed':
            // A tap — TOGGLE the dock's addressed listening window (D1). Stamped
            // with the STATION clock so the utterance correlation (also station
            // clock) is skew-free. Tap on = open window; tap again = close it.
            session(dock).tap();
            break;
          case 'vad':
            // VAD activity from the phone — extends an open listening/followup
            // window so a slow speaker isn't cut off mid-sentence.
            session(dock).vadActivity();
            break;
          case 'face-arrival': {
            // a NEW face in view → low-priority listen (station decides; yields to
            // an active tap/followup).
            session(dock).faceArrival();
            // LONG-ABSENCE GREETING: if it's been a while since anyone was last in
            // front of this dock, proactively greet (a self-thought turn; the LLM
            // uses its perception grounding/identity to name them if known). Not on
            // every walk-up — only after a real gap. Coalesced so a flicker of
            // arrivals doesn't stack greetings.
            const nowMs = Date.now();
            const prev = lastFaceArrival.get(dock);
            lastFaceArrival.set(dock, nowMs);
            if (prev != null && nowMs - prev >= GREET_ABSENCE_MS) {
              session(dock).enqueueAutonomousTurn({
                turnId: `greet-${randomUUID()}`,
                trigger: { kind: 'self', text:
                  '[Someone just came into view after a long absence. If you recognise them, greet them warmly by name and note it\'s been a while; otherwise a friendly hello. Keep it to one short sentence.]' },
                expiresAt: nowMs + 30_000,
                coalesceKey: 'greet-arrival',
              });
            }
            break;
          }
          case 'face-left':
            // a face left → release ONLY a face listen window (never a tap/followup).
            session(dock).faceLeft();
            break;
          case 'turn-cancel':
            session(dock).cancel(typeof p?.turnId === 'string' ? p.turnId : undefined);
            break;
          case 'speech-status':
            session(dock).noteSpeech(p?.speaking === true);
            // A1.2 echo-gate: tell the STT processor to drop audio while our TTS
            // plays, so the station doesn't transcribe the dock's own voice.
            getTranscriptApi()?.setSpeaking(dock, p?.speaking === true);
            break;
          // 'tool-result' is consumed by the RpcBroker's own subscription
          default:
            break;
        }
      });

      // task processes publish on the `tasks` topic; route each frame to the
      // supervisor (scoped to the sender's dock via its hello, never the payload).
      bus.on('tasks', (msg) => {
        if (msg.source === 'station') return; // our own init/input/stop frames
        const dock = dockOf(msg.source);
        if (!dock) return;
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        const instanceId = typeof p.instanceId === 'string' ? p.instanceId : '';
        if (!instanceId) return;
        // capability requests are served by the broker (dispatch + reply); all other
        // frames (status/notify/finish/…) go to the supervisor.
        if (msg.kind === 'request') { void capBroker.handle(dock, instanceId, p); return; }
        supervisor.onFrame(dock, { instanceId, kind: msg.kind, payload: p });
      });

      // resync handshake + turn-abort on voice-component connectivity
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        const p = msg.payload as { id?: string; dock?: string; caps?: string[]; component?: string } | null;
        if (!p?.dock) return;
        if (msg.kind === 'peer-joined' && (p.caps ?? []).includes('voice')) {
          // best-effort (may race the peer's subscribe — the agent/hello
          // handler above is the guaranteed path)
          bus.publish({
            topic: 'agent', kind: 'brain-status',
            payload: { ready: true, activeTurnId: null },
            source: 'station', to: p.id,
          });
        }
        if (msg.kind === 'peer-left') {
          const s = sessions.get(p.dock);
          if (!s) return;
          // A TASK peer (component "task:<id>") leaving is NOT the dock going
          // offline — a reminder's own task process disconnecting must NOT cancel
          // the autonomous turn it just triggered (this silently killed every
          // reminder: TURNEND cancelled, empty reply). Only a real dock component
          // (phone/body) loss matters here.
          if (p.component?.startsWith('task:')) return;
          // any component loss aborts in-flight tool RPCs for safety; voice
          // loss kills the turn itself (the conversation has no mouth).
          rpc.rejectAllForDock(p.dock, 'dock component went offline');
          s.onDockOffline();
        }
      });

      const sweep = setInterval(() => {
        for (const s of sessions.values()) s.maybeIdleClose();
      }, IDLE_SWEEP_MS);
      sweep.unref?.();

      // FAILPROOF task-digest: re-push the running-tasks view to every live dock on
      // a short cadence, so the app HUD self-corrects if any single push was missed
      // (a task that started/stopped without a signal, a dropped frame, etc.). Cheap
      // (a small directed frame per active dock; skipped when nothing's running and
      // nothing changed is not worth tracking — just send it).
      const digestSweep = setInterval(() => {
        for (const dock of sessions.keys()) pushTaskDigest(dock);
      }, DIGEST_SWEEP_MS);
      digestSweep.unref?.();
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (req.method === 'GET' && subPath === '/docks') {
        const lanes = [...sessions.values()].map((s) => ({
          dock: s.dock, sessionId: s.sessionId ?? null,
          turnActive: s.turnActive, lastTurnEndedAt: s.lastTurnEndedAt,
          state: s.state(), // 2c: attention state (idle/listening/speaking/thinking)
          inflightToolCalls: rpc.inflight(s.dock),
        }));
        json(res, 200, lanes);
        return true;
      }
      // which API key the brain will use for the current model (name + set/unset
      // + the paid fallback) — surfaced in the console so the active key is
      // never a mystery.
      if (req.method === 'GET' && subPath === '/keystatus') {
        const model = typeof w.config('brainModel') === 'string' ? (w.config('brainModel') as string) : '';
        json(res, 200, keyStatusFor(model, w.config('brainAlwaysPaid') === true));
        return true;
      }
      // the dock's full brain CONTEXT in one call: effective config, key status,
      // live composition, memory (latest summary), skills, and the system
      // prompt the brain would actually send right now. Powers the Brain view's
      // "dock console" — everything about THIS dock's brain in context.
      const pm = subPath.match(/^\/([^/]+)\/profile$/);
      if (pm && req.method === 'GET') {
        const dock = decodeURIComponent(pm[1]!);
        // enrich with the LIVE session's attention state (idle/listening/speaking/
        // thinking) + the grounding block, for the console's 2c test surface. The
        // session may not exist yet (lazy) → 'idle' + whatever grounding exists.
        const live = sessions.get(dock);
        void buildDockProfile(dock, w, store).then((p) => json(res, 200, {
          ...p,
          state: live?.state() ?? 'idle',
          listening: live?.isListening() ?? false,
          grounding: getPerceptionGrounding()?.forDock(dock) ?? null,
        }));
        return true;
      }
      // ── 2c DEBUG: toggle the stubbed `listening` state (user mid-utterance) so the
      // console can exercise the thought-defer path by hand. No real mic signal yet
      // (Phase A1); this is the test seam. POST /:dock/listening {listening:bool}
      const lm = subPath.match(/^\/([^/]+)\/listening$/);
      if (lm && req.method === 'POST') {
        const dock = decodeURIComponent(lm[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { listening?: boolean };
        session(dock).setListening(body.listening === true);
        json(res, 200, { ok: true, listening: body.listening === true });
        return true;
      }
      // GET /:dock/conversation — the live conversation state probe (the primary
      // testability hook: { mode, windowUntil, speakUntil, msToExpiry }).
      const cm = subPath.match(/^\/([^/]+)\/conversation$/);
      if (cm && req.method === 'GET') {
        json(res, 200, session(decodeURIComponent(cm[1]!)).conversation());
        return true;
      }
      let m = subPath.match(/^\/([^/]+)\/sessions$/);
      if (m && req.method === 'GET') {
        json(res, 200, store.sessions(decodeURIComponent(m[1]!)));
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/history$/);
      if (m && req.method === 'GET') {
        const dock = decodeURIComponent(m[1]!);
        const open = store.openSession(dock);
        json(res, 200, open ? store.messages(dock, open.sessionId) : []);
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/session\/end$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        sessions.get(dock)?.endSession('console');
        json(res, 200, { ok: true });
        return true;
      }
      // ── internal THOUGHT poke (docs/perception-to-brain.md Phase 1) ──────────
      // Inject a self-originated thought into the dock's session — the test seam
      // for internal-thought routing before the real attention gate exists. The
      // thought runs the SAME autonomous-turn lane as a task (user turns still
      // win), but with trigger.kind:'self' so the prompt frames it as the robot's
      // own observation. `text` is the thought; later this comes from the live
      // perception summary instead of the request body.
      m = subPath.match(/^\/([^/]+)\/think$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; ttlMs?: number; kind?: string };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) { json(res, 400, { error: 'body.text (the thought) is required' }); return true; }
        const ttl = typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : 30_000;
        // coalesce by thought KIND (default 'self:test') so a newer thought of the
        // same kind replaces a stale pending one, but different kinds don't clobber.
        const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'test';
        session(dock).enqueueAutonomousTurn({
          turnId: `self-${randomUUID()}`,
          trigger: { kind: 'self', text },
          expiresAt: Date.now() + ttl,
          coalesceKey: `self:${kind}`,
        });
        json(res, 200, { ok: true });
        return true;
      }
      // ── debug: simulate an ADDRESSED utterance (A1.2 self-test, no live mic) ──
      // POST /:dock/debug/say {text} → taps the latch + feeds `text` as a final
      // transcript, driving the real addressed→turn→adopt path. Lets the loop be
      // tested end-to-end (incl. the phone adopting the station-originated turn)
      // without anyone speaking. The dock will reply through DockTts as usual.
      m = subPath.match(/^\/([^/]+)\/debug\/say$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) { json(res, 400, { error: 'body.text (the utterance) is required' }); return true; }
        injectAddressed(dock, text);
        json(res, 200, { ok: true, injected: text });
        return true;
      }
      // POST /:dock/debug/event {event, [endedAt], [text]} — inject a RAW
      // conversation event to drive any flow headless (no mic):
      //   tap | vad | tts-start | tts-end | connected | utterance{text,endedAt}
      // utterance runs the addressed path (→ a turn if a window is open).
      m = subPath.match(/^\/([^/]+)\/debug\/event$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const b = JSON.parse((await readBody(req)) || '{}') as { event?: string; text?: string; endedAt?: number };
        const s = session(dock);
        switch (b.event) {
          case 'tap': s.tap(); break;
          case 'vad': s.vadActivity(); break;
          case 'face-arrival': s.faceArrival(); break;
          case 'face-left': s.faceLeft(); break;
          case 'tts-start': s.noteSpeech(true); break;
          case 'tts-end': s.noteSpeech(false); break;
          case 'connected': s.notePhoneConnected(); break;
          case 'utterance': {
            const endedAt = typeof b.endedAt === 'number' ? b.endedAt : Date.now();
            const addressed = s.utteranceAddressed(endedAt);
            if (addressed && b.text) {
              void s.handleTurnRequest({ turnId: `addr-${randomUUID()}`, trigger: { kind: 'user', text: b.text.trim() }, stationOriginated: true })
                .catch((err) => console.error(`[brain] ${dock}: debug utterance turn crashed`, err));
            }
            json(res, 200, { ok: true, addressed, conversation: s.conversation() });
            return true;
          }
          default: json(res, 400, { error: 'event must be tap|vad|face-arrival|face-left|tts-start|tts-end|connected|utterance' }); return true;
        }
        json(res, 200, { ok: true, conversation: s.conversation() });
        return true;
      }
      // delete a specific session (transcript + index entry). Refuses the
      // currently-open one; the obs trace is dropped via the obs DELETE route.
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const dock = decodeURIComponent(m[1]!);
        const sid = decodeURIComponent(m[2]!);
        const r = store.delete(dock, sid);
        json(res, r === 'deleted' ? 200 : r === 'open' ? 409 : 404, { ok: r === 'deleted', reason: r });
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)\/resume$/);
      if (m && req.method === 'POST') {
        // session(dock) (not sessions.get): the lane may not exist yet after
        // a station restart — resuming must still work.
        const ok = session(decodeURIComponent(m[1]!)).resume(decodeURIComponent(m[2]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      // ── skills (docs/decision-traces/server-brain-selfmod.md §1a) — per-dock install/list/remove.
      // The dock's NEXT session picks up an installed skill (loaded per turn).
      m = subPath.match(/^\/([^/]+)\/skills$/);
      if (m && req.method === 'GET') {
        json(res, 200, await listDockSkills(store.root, decodeURIComponent(m[1]!)));
        return true;
      }
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        try {
          const body = JSON.parse(await readBody(req)) as { content?: string };
          if (typeof body.content !== 'string' || body.content.trim().length === 0) {
            json(res, 400, { error: 'body.content (the SKILL.md text) is required' });
            return true;
          }
          const name = await installDockSkill(store.root, dock, body.content);
          json(res, 200, { ok: true, name });
        } catch (err) {
          json(res, 400, { error: String(err instanceof Error ? err.message : err) });
        }
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/skills\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const ok = await removeDockSkill(store.root, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }

      // ── tasks (docs/tasks.md §8) ───────────────────────────────────────
      // definitions (shared, by name)
      if (req.method === 'GET' && subPath === '/tasks') {
        const defs = await loadAllTaskDefs(taskRoots);
        json(res, 200, defs.map((d) => ({ name: d.name, description: d.description, params: d.manifest.params ?? [], goal: d.goal, source: d.source })));
        return true;
      }
      m = subPath.match(/^\/tasks\/([^/]+)$/);
      if (m && req.method === 'GET') {
        try {
          const def = await findTaskDef(taskRoots, decodeURIComponent(m[1]!));
          json(res, 200, { name: def.name, description: def.description, manifest: def.manifest, goal: def.goal, source: def.source });
        } catch (err) { json(res, 404, { error: String(err) }); }
        return true;
      }
      // instances (dock-scoped, by id)
      m = subPath.match(/^\/([^/]+)\/instances$/);
      if (m && req.method === 'GET') {
        json(res, 200, supervisor.list(decodeURIComponent(m[1]!)));
        return true;
      }
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; params?: Record<string, unknown> };
        try {
          const parent = store.openSession(dock)?.sessionId;
          if (!parent) { json(res, 409, { error: 'no open session for this dock' }); return true; }
          const def = await findTaskDef(taskRoots, body.name ?? '');
          const v = validateParams(def.manifest, body.params ?? {});
          if (!v.ok) { json(res, 400, { error: v.errors.join('; ') }); return true; }
          const id = supervisor.start({ dock, name: def.name, filePath: def.filePath, params: v.values, parentSessionId: parent });
          pushTaskDigest(dock); // immediate HUD update on start (the sweep is the backstop)
          json(res, 200, { instanceId: id });
        } catch (err) { json(res, 400, { error: String(err) }); }
        return true;
      }
      // resolve an instance ONLY if it belongs to the dock in the path — REST is
      // dock-scoped like the WS path, so dockA can't touch dockB's tasks by id.
      const inDock = (pathDock: string, id: string) => {
        const info = supervisor.get(id);
        return info && info.dock === decodeURIComponent(pathDock) ? info : undefined;
      };
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[2]!);
        const info = inDock(m[1]!, id);
        if (!info) { json(res, 404, { error: 'no such instance' }); return true; }
        json(res, 200, { ...info, status: supervisor.status(id), log: supervisor.logTail(id) });
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/(status|logs)$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[2]!);
        if (!inDock(m[1]!, id)) { json(res, 404, { error: 'no such instance' }); return true; }
        json(res, 200, m[3] === 'status' ? { status: supervisor.status(id) } : { log: supervisor.logTail(id) });
        return true;
      }
      // the task's OWN source (read-only) — so the console can inspect how a
      // running instance actually works. Path comes from the supervisor's record
      // of THIS instance (never the request), so it can't read arbitrary files.
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/source$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[2]!);
        const info = inDock(m[1]!, id);
        if (!info) { json(res, 404, { error: 'no such instance' }); return true; }
        try { json(res, 200, { filePath: info.filePath, source: readFileSync(info.filePath, 'utf8') }); }
        catch (err) { json(res, 404, { error: String(err) }); }
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/(pause|resume|stop|restart)$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[2]!);
        if (!inDock(m[1]!, id)) { json(res, 404, { ok: false }); return true; }
        const op = m[3]!;
        const ok = op === 'restart' ? !!(await supervisor.restart(id)) : supervisor[op as 'pause' | 'resume' | 'stop'](id);
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/input$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[2]!);
        if (!inDock(m[1]!, id)) { json(res, 404, { ok: false }); return true; }
        const body = JSON.parse((await readBody(req)) || '{}') as { answer?: string };
        const ok = supervisor.provideInput(id, body.answer ?? '');
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      return false;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * The dock's full brain context in one payload — the "dock console" data:
 * effective config, key status, live composition, memory (latest closed
 * session's summary), skills, and the SYSTEM PROMPT the brain would send right
 * now (assembled exactly as a turn would, minus the live per-turn perception).
 */
async function buildDockProfile(dock: string, w: BrainWiring, store: SessionStore) {
  const cfg = (k: string) => w.config(k);
  const str = (k: string) => (typeof cfg(k) === 'string' ? (cfg(k) as string) : '');
  const model = str('brainModel');

  // skills (per-dock folder) + the prompt block they contribute
  let skills: Awaited<ReturnType<typeof loadDockSkills>> = { skills: [], promptBlock: '' };
  try { skills = await loadDockSkills(store.root, dock); } catch { /* none */ }

  // memory = the latest CLOSED session's summary (what seeds a fresh session)
  const sessions = store.sessions(dock);
  const memory = sessions.find((s) => s.closedAt != null && s.summary)?.summary;

  // live composition (voice/face/camera/servo presence)
  const info = w.directory.dockInfo(dock);
  const fileAccess = cfg('brainFileAccess') === true;
  const bodyLine = w.directory.resolveCap(dock, 'servo') != null
    ? 'Body: CONNECTED. Parts you can move — neck (head tilt), foot (base swivel); use the move tool.'
    : 'Body: NOT connected (movement requests will be ignored).';

  // the effective system prompt, assembled as a real turn would (sans the live
  // perception snapshot, which only exists mid-turn).
  const systemPrompt = buildSystemPrompt({
    persona: str('brainPersona') || undefined,
    memory,
    skills: [skills.promptBlock, fileAccess ? FILE_TOOLS_PROMPT : ''].filter(Boolean).join('\n\n') || undefined,
    context: bodyLine,
    // the live grounding the dock would inject right now (so the console preview
    // matches a real turn). Best-effort — undefined on a cold dock.
    grounding: getPerceptionGrounding()?.forDock(dock),
  });

  const grantsAll = cfg('brainGrants') as Record<string, unknown> | undefined;

  return {
    dock,
    config: {
      brainModel: model,
      brainPersona: str('brainPersona'),
      brainThinkingLevel: str('brainThinkingLevel') || 'off',
      brainTurnTimeoutMs: typeof cfg('brainTurnTimeoutMs') === 'number' ? cfg('brainTurnTimeoutMs') : 60_000,
      brainSkills: cfg('brainSkills') !== false,
      brainFileAccess: fileAccess,
      brainAlwaysPaid: cfg('brainAlwaysPaid') === true,
      brainGrants: (grantsAll && typeof grantsAll === 'object' ? (grantsAll as Record<string, unknown>)[dock] : undefined) ?? {},
    },
    key: keyStatusFor(model, cfg('brainAlwaysPaid') === true),
    composition: {
      components: info.components.map((c) => ({
        component: c.component, kind: c.kind, caps: c.caps, online: c.online, build: c.build,
      })),
    },
    memory: memory ?? null,
    skills: skills.skills.map((s) => ({ name: s.name, description: s.description })),
    sessionCount: sessions.length,
    openSession: sessions.find((s) => s.closedAt == null)?.sessionId ?? null,
    systemPrompt,
  };
}
