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
  entry({ key: 'logLevel', type: 'text', schema: z.enum(['debug', 'info', 'warn', 'error']), default: 'info', tags: ['station'] }),
  entry({ key: 'heartbeatSec', type: 'number', schema: z.number().int().min(1).max(120), default: 10, tags: ['station'] }),

  entry({ key: 'idleAnimations', type: 'boolean', schema: z.boolean(), default: true, tags: ['brain'] }),
  entry({ key: 'gazeTracking', type: 'boolean', schema: z.boolean(), default: true, tags: ['brain'] }),
  entry({ key: 'ttsRate', type: 'number', schema: z.number().min(0.5).max(2), default: 1.0, tags: ['brain'] }),
  entry({ key: 'cameraDefaultOn', type: 'boolean', schema: z.boolean(), default: false, tags: ['brain'] }),
  entry({ key: 'thinkingLevel', type: 'text', schema: z.enum(['low', 'medium', 'high']), default: 'low', tags: ['brain'] }),
  // ── server brain (docs/SERVER-BRAIN-IMPL.md §3.1) — consumed in-process by
  // the brain module, applied at turn start; tag 'station' (never pushed to
  // devices). Provider API keys are station env vars, not config.
  entry({
    key: 'brainModel', type: 'text', schema: z.string(), default: 'google/gemini-2.5-flash', tags: ['station'],
    label: 'Brain model',
    description: 'pi-ai model for dock brain sessions as "provider/modelId" (e.g. "google/gemini-2.5-flash", "anthropic/claude-haiku-4-5", "openai-compatible/<model>@<baseUrl>" for a LAN Ollama). Applied on the next turn.',
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
  entry({ key: 'brainMaxHistoryMessages', type: 'number', schema: z.number().int().min(8).max(400), default: 48, tags: ['station'] }),
  entry({
    key: 'brainVisionGate', type: 'boolean', schema: z.boolean(), default: true, tags: ['station'],
    description: 'Attach the camera frame only on vision-intent turns (small vision models fixate on an always-present image and ignore movement commands).',
  }),
  entry({
    key: 'brainSessionIdleMin', type: 'number', schema: z.number().int().min(1).max(24 * 60), default: 30, tags: ['station'],
    label: 'Session idle close (min)',
    description: 'A brain session closes after this many minutes without a turn (then compacts to a summary). The next turn opens a fresh session.',
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

  // limits are owned by the body but the brain also reads them (to clamp), so
  // both components register interest — sharing, not ownership.
  entry({ key: 'maxSpeedDegPerSec', type: 'number', schema: z.number().int().min(10).max(360), default: 120, tags: ['body', 'brain'] }),
  // Neck is gear-limited and ASYMMETRIC (positive = head down, 0 = straight).
  // Calibrated on hardware: −60° (full up) … +35° (full down). Mirror of
  // DockToolSchemas.DEGREE_LIMITS.
  entry({ key: 'neckPitchMinDeg', type: 'number', schema: z.number().min(-90).max(0), default: -60, tags: ['body', 'brain'] }),
  entry({ key: 'neckPitchMaxDeg', type: 'number', schema: z.number().min(0).max(90), default: 35, tags: ['body', 'brain'] }),
  entry({ key: 'footYawLimitDeg', type: 'number', schema: z.number().min(0).max(90), default: 90, tags: ['body', 'brain'] }),
  entry({ key: 'idleGestures', type: 'boolean', schema: z.boolean(), default: true, tags: ['body'] }),
];

export function findEntry(key: string): ConfigEntry | undefined {
  return REGISTRY.find((e) => e.key === key);
}
