/**
 * The idle-moods PICKER — the whole mood policy as one PURE function (unit-tested truth
 * tables, injected randomness — the same discipline as face-follow's control.ts and the
 * conductor's decide()). Given the cheap world reads a bit needs (local hour, presence,
 * time since conversation / last spoken line), pick WHICH bit to perform and whether its
 * spoken line is allowed.
 *
 * Rules (the spec, in order):
 *  - QUIET HOURS → only sleepy bits are eligible, and speech is NEVER allowed.
 *  - Outside quiet hours sleepy bits are excluded (they'd read as ignoring people).
 *  - attention bits need someone CONTINUOUSLY present ≥ attentionAfterMs, AND at most ONE
 *    attention bit per presence stretch (`attentionSpent`) — a creature that offers once
 *    and lets it go is endearing; one that re-asks every few minutes is needy.
 *  - needsFace bits drop when nobody is visible; needsNoFace bits drop when someone IS
 *    (flavor.lonely must never say "nobody's around" to someone's face).
 *  - ANTI-REPEAT: the previously performed bit (`lastBitId`) leaves the pool (unless it's
 *    all that's left) — the same twitch twice in a row reads as a tic.
 *  - The SPEAK GATE: a spoken line is allowed only outside quiet hours, ≥ speakMinGapMs
 *    since the last spoken bit, and ≥ speakIdleMinMs since the last conversation. When
 *    the gate is CLOSED, thought-only bits leave the pool; motion+thought bits stay and
 *    run silent.
 *  - Weighted random pick: bit.weight × the mood's tuning weight (0 disables a mood).
 */
import type { Bit, MoodName } from './bits.js';

export interface MoodCfg {
  /** a REACTIVE bit needs a salient perception event within this window (ms) to be
   *  eligible — the mechanical form of "self-talk reacts to happenings". */
  freshEventMaxMs: number;
  quietStartHour: number;      // local hour [0..23]; start === end → quiet hours disabled
  quietEndHour: number;
  attentionAfterMs: number;    // continuous presence before attention bits are eligible
  speakMinGapMs: number;       // min gap between spoken bits
  speakIdleMinMs: number;      // min silence after a conversation before ANY spoken bit
  weights: Partial<Record<MoodName, number>>;  // per-mood multiplier (missing → 1, 0 → off)
}

export interface PickInput {
  /** ms since the dock last perceived a salient HAPPENING; null = perception cold
   *  (treat as no recent event — reactive bits stay ineligible). */
  msSinceSalient: number | null;
  hourLocal: number;
  facesPresent: boolean;
  msPresentContinuous: number; // 0 when nobody is visible
  msSinceConversation: number;
  msSinceLastSpoke: number;
  /** the previously performed bit — excluded from this pick (anti-tic). */
  lastBitId?: string | null;
  /** an attention bit already played during THIS presence stretch → attention stays out. */
  attentionSpent?: boolean;
  rand: () => number;          // [0,1) — injected for determinism
}

/** Local-hour quiet window, wrapping midnight (22→7 = 22..23 + 0..6). start===end → never. */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The eligibility reasoning behind a pick — surfaced (not consumed) so a spoken bit is
 *  attributable in the logs + observability trace. The recurring live question is "why did
 *  a REACTIVE bit like bored.muse speak?": `reactive`/`salientMs`/`freshEventMaxMs` answer it
 *  (was there a genuine fresh happening, or did it fire on a stale world?). */
export interface PickWhy {
  quiet: boolean;
  /** the speak-gate verdict + which of its three conditions were open. */
  canSpeak: boolean;
  gate: { notQuiet: boolean; spokeGapOk: boolean; convGapOk: boolean };
  /** ms since the last salient happening (null = perception cold), and the reactive window. */
  salientMs: number | null;
  freshEventMaxMs: number;
  /** did the PICKED bit require (and pass) the reactive fresh-event gate? undefined = the bit
   *  isn't reactive, so the gate didn't apply. */
  reactive?: boolean;
}

/** Pick a bit + whether it may speak, or null when nothing is eligible this cycle. */
export function pickBit(inp: PickInput, cfg: MoodCfg, bits: Bit[]): { bit: Bit; speak: boolean; why: PickWhy } | null {
  const quiet = inQuietHours(inp.hourLocal, cfg.quietStartHour, cfg.quietEndHour);
  const spokeGapOk = inp.msSinceLastSpoke >= cfg.speakMinGapMs;
  const convGapOk = inp.msSinceConversation >= cfg.speakIdleMinMs;
  const canSpeak = !quiet && spokeGapOk && convGapOk;
  const why: PickWhy = {
    quiet, canSpeak,
    gate: { notQuiet: !quiet, spokeGapOk, convGapOk },
    salientMs: inp.msSinceSalient, freshEventMaxMs: cfg.freshEventMaxMs,
  };

  const w = (b: Bit) => b.weight * (cfg.weights[b.mood] ?? 1);
  let eligible = bits.filter((b) => {
    if (quiet) { if (b.mood !== 'sleepy') return false; }
    else if (b.mood === 'sleepy') return false;
    if (b.needsFace && !inp.facesPresent) return false;
    if (b.needsNoFace && inp.facesPresent) return false;
    if (b.mood === 'attention'
      && !(inp.facesPresent && inp.msPresentContinuous >= cfg.attentionAfterMs && !inp.attentionSpent)) return false;
    // a thought-ONLY bit has nothing to perform while the speak gate is closed.
    if (!canSpeak && b.thought && !b.gesture && !b.steps?.length) return false;
    // REACTIVE bits need a recent salient HAPPENING (event-triggered self-talk,
    // idle-cognition.md principle 2): no event in the window (or perception cold)
    // → the observational bits sit out; the world simply hasn't offered anything.
    if (b.reactive && (inp.msSinceSalient == null || inp.msSinceSalient > cfg.freshEventMaxMs)) return false;
    return w(b) > 0;
  });
  // anti-repeat: drop the last-performed bit unless that would empty the pool.
  if (inp.lastBitId && eligible.length > 1) {
    const rest = eligible.filter((b) => b.id !== inp.lastBitId);
    if (rest.length > 0) eligible = rest;
  }

  const total = eligible.reduce((s, b) => s + w(b), 0);
  if (total <= 0) return null;
  let roll = inp.rand() * total;
  for (const b of eligible) {
    roll -= w(b);
    if (roll < 0) return { bit: b, speak: canSpeak && !!b.thought, why: { ...why, reactive: !!b.reactive } };
  }
  const last = eligible[eligible.length - 1]!;   // rand() edge (roll === total)
  return { bit: last, speak: canSpeak && !!last.thought, why: { ...why, reactive: !!last.reactive } };
}
