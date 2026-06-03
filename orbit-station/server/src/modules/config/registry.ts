/**
 * The config REGISTRY: the single declared catalogue of every config entry the
 * station knows about. Each entry has a scope, a value type the UI renders an
 * editor for (number/boolean/text/json), a Zod schema that VALIDATES writes,
 * and a default value (the safe baseline baked into firmware/app builds).
 *
 * Adding a new knob = add an Entry here. The store, REST validation, the push
 * protocol, the build export, and the type-aware UI all derive from this — one
 * source of truth, no per-knob wiring.
 */

import { z } from 'zod';

export type Scope = 'station' | 'dock' | 'body';
export type ValueType = 'number' | 'boolean' | 'text' | 'json';

export interface ConfigEntry {
  scope: Scope;
  key: string;
  type: ValueType;
  /** Validates any incoming value for this key. */
  schema: z.ZodTypeAny;
  /** Safe baseline; what a fresh db / offline device falls back to. */
  default: unknown;
  /** Human label + help for the UI. */
  label?: string;
  description?: string;
  /**
   * For `json` entries: an optional JSON-Schema the UI can use to render a
   * schema-aware editor (and document the shape). Derived from `schema` via
   * zod-to-json-schema at registration so it never drifts from validation.
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

/** The default gesture choreography — mirrors DockTools.expressionGesture().
 *  Degrees, device-independent; the app converts to µs on the fixed scale. */
const FACE_GESTURES_DEFAULT = {
  sleepy: [
    { part: 'neck', degrees: -30, duration_ms: 900 }, { wait_ms: 250 },
    { part: 'neck', degrees: -18, duration_ms: 350 },
    { part: 'neck', degrees: -38, duration_ms: 1100 }, { wait_ms: 300 },
  ],
  happy: [
    { parts: [{ part: 'neck', degrees: 12 }, { part: 'foot', degrees: 12 }], duration_ms: 280 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: -12 }], duration_ms: 320 },
    { parts: [{ part: 'neck', degrees: 8 }, { part: 'foot', degrees: 0 }], duration_ms: 260 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 300 },
  ],
  excited: [
    { parts: [{ part: 'neck', degrees: 10 }, { part: 'foot', degrees: 16 }], duration_ms: 120 },
    { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: -16 }], duration_ms: 120 },
    { parts: [{ part: 'neck', degrees: 10 }, { part: 'foot', degrees: 16 }], duration_ms: 120 },
    { parts: [{ part: 'neck', degrees: -10 }, { part: 'foot', degrees: -16 }], duration_ms: 120 },
    { parts: [{ part: 'neck', degrees: 10 }, { part: 'foot', degrees: 16 }], duration_ms: 120 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 220 },
  ],
  love: [
    { parts: [{ part: 'neck', degrees: 22 }, { part: 'foot', degrees: 14 }], duration_ms: 700 }, { wait_ms: 500 },
    { parts: [{ part: 'neck', degrees: 16 }, { part: 'foot', degrees: 8 }], duration_ms: 600 },
  ],
  curious: [
    { parts: [{ part: 'neck', degrees: 20 }, { part: 'foot', degrees: -18 }], duration_ms: 450 }, { wait_ms: 400 },
    { part: 'neck', degrees: 14, duration_ms: 300 },
  ],
  surprised: [
    { part: 'neck', degrees: 38, duration_ms: 130 }, { wait_ms: 450 },
    { part: 'neck', degrees: 20, duration_ms: 350 },
  ],
  sad: [
    { parts: [{ part: 'neck', degrees: -28 }, { part: 'foot', degrees: 30 }], duration_ms: 1000 }, { wait_ms: 400 },
    { part: 'neck', degrees: -34, duration_ms: 700 },
  ],
  angry: [
    { part: 'foot', degrees: -30, duration_ms: 130 }, { part: 'foot', degrees: 30, duration_ms: 130 },
    { part: 'foot', degrees: -26, duration_ms: 130 }, { part: 'foot', degrees: 24, duration_ms: 130 },
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 0 }], duration_ms: 180 },
  ],
  concerned: [
    { part: 'neck', degrees: -12, duration_ms: 450 }, { part: 'neck', degrees: 12, duration_ms: 500 },
    { part: 'neck', degrees: -8, duration_ms: 450 }, { part: 'neck', degrees: 0, duration_ms: 400 },
  ],
  wink: [
    { part: 'neck', degrees: 16, duration_ms: 200 }, { part: 'neck', degrees: 0, duration_ms: 220 },
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
  entry({ scope: 'station', key: 'logLevel', type: 'text', schema: z.enum(['debug', 'info', 'warn', 'error']), default: 'info' }),
  entry({ scope: 'station', key: 'heartbeatSec', type: 'number', schema: z.number().int().min(1).max(120), default: 10 }),

  entry({ scope: 'dock', key: 'idleAnimations', type: 'boolean', schema: z.boolean(), default: true }),
  entry({ scope: 'dock', key: 'gazeTracking', type: 'boolean', schema: z.boolean(), default: true }),
  entry({ scope: 'dock', key: 'ttsRate', type: 'number', schema: z.number().min(0.5).max(2), default: 1.0 }),
  entry({ scope: 'dock', key: 'cameraDefaultOn', type: 'boolean', schema: z.boolean(), default: false }),
  entry({ scope: 'dock', key: 'thinkingLevel', type: 'text', schema: z.enum(['low', 'medium', 'high']), default: 'low' }),
  entry({
    scope: 'dock', key: 'faceGestures', type: 'json',
    schema: faceGesturesSchema, default: FACE_GESTURES_DEFAULT,
    label: 'Face gestures',
    description: 'Body choreography the dock performs when set_face sets an expression. Each gesture is a list of move steps (degrees).',
  }),

  entry({ scope: 'body', key: 'maxSpeedDegPerSec', type: 'number', schema: z.number().int().min(10).max(360), default: 120 }),
  entry({ scope: 'body', key: 'neckPitchLimitDeg', type: 'number', schema: z.number().min(0).max(90), default: 45 }),
  entry({ scope: 'body', key: 'footYawLimitDeg', type: 'number', schema: z.number().min(0).max(90), default: 90 }),
  entry({ scope: 'body', key: 'idleGestures', type: 'boolean', schema: z.boolean(), default: true }),
];

export function findEntry(scope: string, key: string): ConfigEntry | undefined {
  return REGISTRY.find((e) => e.scope === scope && e.key === key);
}
