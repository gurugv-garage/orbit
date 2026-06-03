/**
 * Degree ↔ pulse_width_us conversion for the body — the SAME mapping the dock
 * app uses (node-dock/app/.../llm/DockToolSchemas.kt). Keep in sync.
 *
 * The scale is FIXED and universal: -90° = 500µs, 0° = 1500µs, +90° = 2500µs
 * (1° ≈ 11.11µs). A degree is the same physical angle for every part.
 *
 * DEGREE_RANGE is a per-part LIMIT on the allowed command (not a rescale) — the
 * console clamps + labels to it. Change ONLY a part's number to widen/narrow it.
 * neck = gear-limited (±45°); foot = direct swivel (±90°).
 */

const FULL_SWING_DEG = 90;

export const DEGREE_RANGE: Record<string, number> = {
  neck: 45,
  foot: 90,
};

/** Absolute angle (deg) → servo pulse width (µs): clamp to the part limit, then map on the fixed ±90° scale. */
export function degreesToUs(part: string, degrees: number): number {
  const limit = DEGREE_RANGE[part] ?? FULL_SWING_DEG;
  const clamped = Math.max(-limit, Math.min(limit, degrees));
  return Math.round(1500 + (clamped / FULL_SWING_DEG) * 1000);
}

/** Servo pulse width (µs) → angle (deg) on the fixed ±90° scale (independent of the part limit). */
export function usToDegrees(part: string, us: number): number | null {
  if (!(part in DEGREE_RANGE)) return null;
  const deg = ((us - 1500) / 1000) * FULL_SWING_DEG;
  return Math.round(deg * 10) / 10; // 0.1° resolution
}

/** True if we know a degree mapping for this part. */
export function hasAngle(part: string): boolean {
  return part in DEGREE_RANGE;
}
