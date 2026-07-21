/**
 * faceGesture posture invariants. The bug (2026-07-21): the `curious` gesture ended
 * at neck −14 (head cocked UP) with no settle step, so idle-moods' `curious.tilt` bit
 * (a PURE gesture, no steps of its own) left the head craned up and never recovered —
 * "curious just points up and does nothing when idle". The RETURNING gestures must end
 * level (neck 0); a couple are deliberately HELD up (love/surprised) and are exempt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACE_GESTURES_DEFAULT } from './registry.js';

/** the last neck angle a gesture leaves the head at (scan flat + `parts` steps). */
function finalNeck(steps: Array<Record<string, unknown>>): number | undefined {
  let neck: number | undefined;
  for (const s of steps) {
    if (typeof s.part === 'string' && s.part === 'neck' && typeof s.degrees === 'number') neck = s.degrees;
    if (Array.isArray(s.parts)) {
      for (const p of s.parts as Array<{ part: string; degrees: number }>) {
        if (p.part === 'neck') neck = p.degrees;
      }
    }
  }
  return neck;
}

/** the final neck-bearing joint (to inspect its relative flag). */
function finalNeckJoint(steps: Array<Record<string, unknown>>): { degrees: number; relative?: boolean } | undefined {
  let joint: { degrees: number; relative?: boolean } | undefined;
  for (const s of steps) {
    if (s.part === 'neck' && typeof s.degrees === 'number') joint = { degrees: s.degrees, relative: s.relative as boolean | undefined };
    if (Array.isArray(s.parts)) {
      for (const p of s.parts as Array<{ part: string; degrees: number; relative?: boolean }>) {
        if (p.part === 'neck') joint = { degrees: p.degrees, relative: p.relative };
      }
    }
  }
  return joint;
}

// The regression guard: curious RETURNS to true level. Gestures are rebased onto the
// current gaze, so a plain neck:0 would return to wherever the gesture STARTED (the bug —
// curious accreted upward). The settle step must be ABSOLUTE (relative:false) so it lands
// level regardless of start pose.
test('the `curious` gesture returns the neck to level — via an ABSOLUTE settle, not an offset', () => {
  const g = (FACE_GESTURES_DEFAULT as Record<string, Array<Record<string, unknown>>>).curious;
  assert.ok(g, 'curious gesture exists');
  const j = finalNeckJoint(g);
  assert.equal(j?.degrees, 0, 'curious must end at neck 0');
  assert.equal(j?.relative, false, 'the settle must be ABSOLUTE (relative:false) — a rebased 0 would not level');
});

// The broader guard, minus the by-design HELD poses: love(-16)/surprised(-20) hold UP,
// sleepy(38)/sad(34) hold DOWN — each documented in registry.ts as a settled emotional
// posture, and each reached only via set_face during a conversation (a following turn
// moves the body), NOT as a pure fire-and-forget idle bit. Every OTHER neck-touching
// gesture must settle to level so a bit that just plays the gesture and stops can't
// leave the body stuck off-level — the class of bug `curious` was (via curious.tilt).
test('every non-held gesture returns the neck to level (0)', () => {
  const HELD = new Set(['love', 'surprised', 'sleepy', 'sad']); // deliberately end off-level
  const gestures = FACE_GESTURES_DEFAULT as Record<string, Array<Record<string, unknown>>>;
  for (const [name, steps] of Object.entries(gestures)) {
    if (HELD.has(name)) continue;
    const end = finalNeck(steps);
    // a gesture that never touches the neck (pure foot) can't leave it off-level.
    if (end === undefined) continue;
    assert.equal(end, 0, `gesture "${name}" must return the neck to level (ends at ${end})`);
  }
});
