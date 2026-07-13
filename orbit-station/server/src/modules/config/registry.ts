/**
 * The config REGISTRY: the single declared catalogue of every config knob.
 *
 * Keys are FLAT and GLOBAL (unique names, no owner-scope) because configs are
 * SHARED — a value like `bodyAddr` or `neckPitchLimitDeg` is consumed by more
 * than one component. Ownership/routing is NOT derived from the key; instead
 * each component announces the set of keys it's interested in (hardcoded in its
 * init), and the station pushes only those. `tags` is for UI grouping ONLY —
 * never routing. (A "dock" = the brain/app + the body/ESP32; a key can be
 * tagged for both.)
 *
 * Each entry has a value type the UI renders an editor for, a Zod schema that
 * VALIDATES writes, and a default (the safe baseline baked into device builds).
 * The store, REST validation, push protocol, build export, and type-aware UI
 * all derive from this — one source of truth.
 */

import { z } from 'zod';

export type ValueType = 'number' | 'boolean' | 'text' | 'json';
/** UI grouping tags only (brain = phone app, body = ESP32 firmware). */
export type Tag = 'station' | 'brain' | 'body';

export interface ConfigEntry {
  key: string;
  type: ValueType;
  /** Validates any incoming value for this key. */
  schema: z.ZodTypeAny;
  /** Safe baseline; what a fresh db / offline device falls back to. */
  default: unknown;
  /** UI grouping only — which components typically use this key. NOT routing. */
  tags: Tag[];
  /** Human label + help for the UI. */
  label?: string;
  description?: string;
  /**
   * For `json` entries: a JSON-Schema the UI can use to render a schema-aware
   * editor. Derived from `schema` (zod) at read time so it never drifts.
   */
  jsonSchema?: unknown;
}

// ── reusable schemas ─────────────────────────────────────────────────────────

/** One joint target inside a move step: an absolute angle in degrees. */
const moveJoint = z.object({
  part: z.enum(['neck', 'foot']),
  degrees: z.number().min(-90).max(90),
});

/**
 * One move step — IDENTICAL vocabulary to the dock `move` tool: a set of joints
 * that move together (single `part`+`degrees`, or a `parts` array), plus an
 * optional travel duration and trailing pause. A pure `{wait_ms}` step pauses.
 */
const moveStep = z
  .object({
    part: moveJoint.shape.part.optional(),
    degrees: moveJoint.shape.degrees.optional(),
    parts: z.array(moveJoint).optional(),
    duration_ms: z.number().int().min(0).max(5000).optional(),
    wait_ms: z.number().int().min(0).max(5000).optional(),
  })
  .refine(
    (s) => s.parts != null || s.part != null || s.wait_ms != null,
    'a step needs joints (part/parts) or a wait_ms',
  );

/** faceGestures: expression name → ordered move steps the body performs. */
const faceGesturesSchema = z.record(z.string(), z.array(moveStep));

/** The default gesture choreography — MIRRORS DockTools.defaultGesture(). Keep
 *  the two in sync. Degrees, device-independent (app converts to µs).
 *  NECK SIGN (verified on hardware): positive = head DOWN, negative = head UP.
 *  FOOT = base yaw (left/right). */
const FACE_GESTURES_DEFAULT = {
  // Drowsy: head sags forward (DOWN), bobs once, sinks low — "nodding off".
  sleepy: [
    { part: 'neck', degrees: 30, duration_ms: 900 }, { wait_ms: 250 },
    { part: 'neck', degrees: 18, duration_ms: 350 },
    { part: 'neck', degrees: 38, duration_ms: 1100 }, { wait_ms: 300 },
  ],
  // Warm: a gentle up-bob (UP) + small body sway.
  happy: [
    { parts: [{ part: 'neck', degrees: -12 }, { part: 'foot', degrees: 12 }], duration_ms: 280 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: -12 }], duration_ms: 320 },
    { parts: [{ part: 'neck', degrees: -8 }, { part: 'foot', degrees: 0 }], duration_ms: 260 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 300 },
  ],
  // Giddy: fast head+body wiggle/vibrate — the "laughing shake".
  excited: [
    { parts: [{ part: 'neck', degrees: 9 }, { part: 'foot', degrees: 15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: -9 }, { part: 'foot', degrees: -15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: 9 }, { part: 'foot', degrees: 15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: -9 }, { part: 'foot', degrees: -15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: 9 }, { part: 'foot', degrees: 15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: -9 }, { part: 'foot', degrees: -15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: 9 }, { part: 'foot', degrees: 15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: -9 }, { part: 'foot', degrees: -15 }], duration_ms: 80 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 180 },
  ],
  // Smitten: slow dreamy head-tilt UP + lean, held.
  love: [
    { parts: [{ part: 'neck', degrees: -22 }, { part: 'foot', degrees: 14 }], duration_ms: 700 }, { wait_ms: 500 },
    { parts: [{ part: 'neck', degrees: -16 }, { part: 'foot', degrees: 8 }], duration_ms: 600 },
  ],
  // Inquisitive: head cocked UP, body slowly sways left↔right in parallel.
  curious: [
    { parts: [{ part: 'neck', degrees: -18 }, { part: 'foot', degrees: -22 }], duration_ms: 700 }, { wait_ms: 300 },
    { parts: [{ part: 'neck', degrees: -14 }, { part: 'foot', degrees: 22 }], duration_ms: 1100 }, { wait_ms: 300 },
    { parts: [{ part: 'neck', degrees: -18 }, { part: 'foot', degrees: -16 }], duration_ms: 1000 },
    { parts: [{ part: 'neck', degrees: -14 }, { part: 'foot', degrees: 0 }], duration_ms: 700 },
  ],
  // Startled: quick snap UP-and-back, freeze, ease toward level.
  surprised: [
    { part: 'neck', degrees: -38, duration_ms: 130 }, { wait_ms: 450 },
    { part: 'neck', degrees: -20, duration_ms: 350 },
  ],
  // Crestfallen: head sinks low (DOWN), body turns slightly away.
  sad: [
    { parts: [{ part: 'neck', degrees: 28 }, { part: 'foot', degrees: 30 }], duration_ms: 1000 }, { wait_ms: 400 },
    { part: 'neck', degrees: 34, duration_ms: 700 },
  ],
  // Indignant: sharp little "no!" base-shakes, tense and quick.
  angry: [
    { part: 'foot', degrees: -30, duration_ms: 130 }, { part: 'foot', degrees: 30, duration_ms: 130 },
    { part: 'foot', degrees: -26, duration_ms: 130 }, { part: 'foot', degrees: 24, duration_ms: 130 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 180 },
  ],
  // Uneasy: quick little side-to-side "no/no" head shake (base yaw).
  concerned: [
    { part: 'foot', degrees: -16, duration_ms: 180 }, { part: 'foot', degrees: 16, duration_ms: 200 },
    { part: 'foot', degrees: -14, duration_ms: 180 }, { part: 'foot', degrees: 12, duration_ms: 180 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 220 },
  ],
  // Playful: a tiny double head-tilt UP to punctuate the eye-wink.
  wink: [
    { part: 'neck', degrees: -16, duration_ms: 200 }, { part: 'neck', degrees: 0, duration_ms: 220 },
  ],
  neutral: [
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 450 },
  ],
};

// ── the catalogue ────────────────────────────────────────────────────────────

function entry(e: Omit<ConfigEntry, 'jsonSchema'>): ConfigEntry {
  return e;
}

export const REGISTRY: ConfigEntry[] = [
  // ── server brain (docs/decision-traces/server-brain-impl.md §3.1) — consumed in-process by
  // the brain module, applied at turn start; tag 'station' (never pushed to
  // devices). Provider API keys are station env vars, not config.
  //
  // Registry = LIVE-TUNABLE OPS ONLY. Tuning/dev knobs that don't change at
  // runtime live in code (brain/constants.ts): MAX_HISTORY_MESSAGES,
  // SESSION_IDLE_MIN, VISION_GATE. Twelve dead keys (logLevel, heartbeatSec,
  // idleAnimations, gazeTracking, ttsRate, cameraDefaultOn, the old
  // thinkingLevel, the four servo limits, idleGestures) were removed — they
  // were read by no component (server/web/app/firmware); the body's clamp
  // ranges come from the firmware's `profile` message, not config.
  entry({
    key: 'brainModel', type: 'text', schema: z.string(), default: 'google/gemini-2.5-flash', tags: ['station'],
    label: 'Brain model',
    description: 'pi-ai model for dock brain sessions as "provider/modelId" (e.g. "google/gemini-2.5-flash", "anthropic/claude-haiku-4-5", "openai-compatible/<model>@<baseUrl>" for a LAN Ollama). Applied on the next turn.',
  }),
  entry({
    key: 'conductor', type: 'json',
    // Per-dock TUNINGS for the conductor (docs/decision-traces/conductor-v1-design.md):
    // { "<dock>": { "faceFollow": { enabled, activateAfterMs, runForMs },   // a TASK
    //               "wakeUp": { enabled, phrase, prompt },                  // a BEHAVIOUR
    //               "moods": { enabled, activateAfterMs, bitMinMs, bitMaxMs, // a TASK (idle-moods)
    //                          speakMinGapMs, speakIdleMinMs, quietStartHour, quietEndHour,
    //                          attentionAfterMs, wBored, wCurious, wAttention, wSleepy, wFlavor } } }.
    // Missing dock/name/knob → the conducted thing's coded defaults. Live-applied each ~1Hz
    // tick (edit in the Conductor tab). A TASK's tunings ride to the task as its params —
    // snapshot at task start (Stop→Run in the tab to apply an edit to a running task).
    schema: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
    default: {},
    tags: ['station'],
    label: 'Conductor tunings (per dock)',
    description: 'Per-dock enable/disable + knobs for the conducted behaviours (wakeUp) + tasks (faceFollow, moods). Applied live by the per-dock conductor.',
  }),
  entry({
    key: 'brainTaskModels', type: 'json',
    // a plain string[] of "provider/modelId" specs the task author may choose from.
    schema: z.array(z.string()).min(1),
    default: ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite'],
    tags: ['station'],
    label: 'Task models (allowed)',
    description: 'The models a task author may pick from for a task\'s OWN reasoning (this.ask/this.agent/vision), trading speed vs accuracy. The author bakes its choice into the task\'s manifest.model; a task that does no LLM work needs none and falls back to the dock brain model. First entry is the safe default.',
  }),
  entry({
    key: 'brainPersona', type: 'text', schema: z.string(), default: '', tags: ['station'],
    label: 'Brain persona',
    description: 'Optional extra persona text appended to the dock system prompt. Empty = the stock prompt.',
  }),
  entry({
    key: 'brainThinkingLevel', type: 'text', schema: z.enum(['off', 'minimal', 'low', 'medium', 'high']), default: 'off', tags: ['station'],
    description: 'Extended reasoning budget for brain turns. Off = lowest latency (the dock default); higher levels stream thinking before answering.',
  }),
  entry({ key: 'brainTurnTimeoutMs', type: 'number', schema: z.number().int().min(5_000).max(300_000), default: 60_000, tags: ['station'] }),
  // ── tasks (docs/tasks.md) ──────────────────────────────────────────────
  entry({
    key: 'brainTaskMax', type: 'number', schema: z.number().int().min(0).max(10), default: 4, tags: ['station'],
    label: 'Max tasks per dock',
    description: 'Max concurrent task INSTANCES a dock may run. 0 disables ALL tasks — the task tools refuse AND the conductor stops starting its standing tasks (face-follow, idle-moods), fully quieting the dock. Note: the standing tasks occupy two instances; the default leaves two for brain-run tasks.',
  }),
  entry({
    key: 'brainTaskSettleMs', type: 'number', schema: z.number().int().min(0).max(10_000), default: 1500, tags: ['station'],
    label: 'Task settle ms',
    description: 'Quiet gap after a turn ends before an autonomous (task) turn may take the lane — avoids barging into a rapid user exchange.',
  }),
  entry({
    key: 'brainTaskRunner', type: 'text', schema: z.enum(['tmux', 'child']), default: 'child', tags: ['station'],
    label: 'Task runner',
    description: 'How task processes run: "child" (default — dies with the station, no orphans) or "tmux" (attachable window to watch a task live; a tmux session outlives the station, so a restart can orphan a long-sleeping task).',
  }),
  entry({
    key: 'brainSkills', type: 'boolean', schema: z.boolean(), default: true, tags: ['station'],
    label: 'Skills',
    description: 'Load per-dock pi Skills from .data/brain/<dock>/skills/ (progressive disclosure: names+descriptions in the prompt, full body via the invoke_skill tool). Off = no skills loaded for any dock.',
  }),
  entry({
    key: 'brainFileAccess', type: 'boolean', schema: z.boolean(), default: false, tags: ['station'],
    label: 'Code access (DANGER)',
    description: 'Give the brain FULL pi coding tools — read/write/edit any file + run shell commands on the station host, INCLUDING its own source. read_file is direct (ask it about its code); every write/edit/run requires user confirmation on the dock UI. Off by default; turning this on lets an LLM modify the running robot.',
  }),
  entry({
    key: 'brainFileAutoApprove', type: 'boolean', schema: z.boolean(), default: false, tags: ['station'],
    label: 'Auto-approve code mutations (EXTREME DANGER)',
    description: 'Skip the dock confirmation popup for write/edit/run_command — the brain runs every mutating command immediately, no human tap. Only meaningful when Code access is on. Off by default; turning this on lets an LLM change and run code on the host with NO approval gate.',
  }),
  entry({
    key: 'brainResearchScript', type: 'text', schema: z.string(), default: '', tags: ['station'],
    label: 'Recent-research script',
    description: 'Absolute path to last30days.py (mvanhorn/last30days-skill). When set (and a Python 3.12+ is on PATH), the brain gets a `research_recent` tool that pulls the last ~30 days of community discussion (Reddit/HN/YouTube/GitHub/Polymarket — no API keys) for a topic. Empty = tool off.',
  }),
  entry({
    key: 'brainInlineMood', type: 'boolean', schema: z.boolean(), default: true, tags: ['station'],
    label: 'Inline mood tag',
    description: 'The reply text leads with a [face:NAME] tag the station strips and applies — the mood costs NO extra LLM step (WI-3, busy-queue RCA: the separate set_face step was a full serial ttft, the dominant term in the 8s median reply latency). Off = the pre-WI-3 behavior: the prompt teaches set_face as a tool call for ordinary moods.',
  }),
  entry({
    key: 'brainThinkingMerge', type: 'boolean', schema: z.boolean(), default: true, tags: ['station'],
    label: 'Merge speech into thinking',
    description: 'Speech heard while the dock is THINKING (nothing spoken yet) cancels the in-flight call and re-asks with the addition folded in — corrections apply immediately and a repeated question gets ONE answer (Addendum 10, busy-queue RCA). Capped at 2 merges per turn; overflow queues. Off = queue everything (pre-merge behavior).',
  }),
  entry({
    key: 'brainVoiceStop', type: 'boolean', schema: z.boolean(), default: true, tags: ['station'],
    label: 'Voice stop',
    description: 'A bare "stop" / "never mind" / "wait" spoken while the dock is replying or moving aborts the turn (the spoken tap-interrupt — WI-2, busy-queue RCA). Deliberately narrow: content sentences containing stop words still queue and get answered. Off = stop words queue like any other speech.',
  }),
  entry({
    key: 'brainAlwaysPaid', type: 'boolean', schema: z.boolean(), default: false, tags: ['station'],
    label: 'Always use paid key',
    description: 'For Google/Gemini: always use the paid-account key (GEMINI_API_KEY_PAID_ACC) instead of the free key. Off = use the free key and fall back to the paid one only when the free key hits a quota or overload (429/503). No effect if no paid key is set.',
  }),
  entry({
    key: 'brainGrants', type: 'json', schema: z.record(z.string(), z.record(z.string(), z.array(z.string()))), default: {}, tags: ['station'],
    label: 'Cross-dock grants',
    description: 'Which OTHER docks each dock\'s brain may act on, by capability: { "<dock>": { "<targetDock>": ["nav", …] } }. Tool exposure is gated by this; default none.',
  }),
  entry({
    key: 'faceGestures', type: 'json', schema: faceGesturesSchema, default: FACE_GESTURES_DEFAULT, tags: ['brain'],
    label: 'Face gestures',
    description: 'Body choreography the dock performs when set_face sets an expression. Each gesture is a list of move steps (degrees).',
  }),
  entry({
    key: 'faceStyle', type: 'text',
    // Keep in sync with FACE_STYLES (modules/brain/schemas.ts) + the dock's FaceRegistry.
    schema: z.enum(['aurora', 'puppy', 'vader', 'robot', 'ghost', 'owl', 'dragon']),
    default: 'aurora', tags: ['brain'],
    label: 'Face style',
    description: 'Which dock face appearance + voice to show (aurora/puppy/vader/robot/ghost/owl/dragon). The brain can also switch it live with set_face_style; that live choice wins until the app restarts.',
  }),
];

export function findEntry(key: string): ConfigEntry | undefined {
  return REGISTRY.find((e) => e.key === key);
}
