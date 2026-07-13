/**
 * audio-trigger — the CHEAP, pure per-frame trigger logic for the audio-enricher
 * triggers (docs/decision-traces/bg-audio-summarizer.md §2 + §7a.3). Decides, from
 * nothing but the per-frame RMS the VAD already computes, whether something acoustically
 * significant happened that is NOT a normal speech endpoint:
 *
 *   • IMPULSE — a sharp energy jump over the rolling baseline (a crash, a bang, a door).
 *   • SUSTAINED — continuous energy for a long stretch without a speech endpoint
 *     (music, an alarm, a running appliance) — fired once per stretch.
 *
 * Speech endpoints remain the third trigger, owned by the UtteranceDetector as today.
 * Pure + injected time so the thresholds are unit-testable without audio files. The
 * trigger NEVER slows sensing — it runs on every frame; only the expensive Gemini call
 * downstream is debounced (perception/index.ts owns the cooldown).
 */

export type AudioTriggerKind = 'impulse' | 'sustained';

export interface AudioTriggerCfg {
  /** rms must exceed baseline × this factor to count as an impulse. */
  impulseFactor: number;
  /** …and exceed this absolute floor (a jump from near-silence to quiet is not a bang). */
  impulseMinRms: number;
  /** refractory per trigger kind: suppress repeats within this window (ms). */
  refractoryMs: number;
  /** sustained: energy ≥ sustainedMinRms for ≥ sustainedMs without an endpoint. */
  sustainedMinRms: number;
  sustainedMs: number;
  /** EMA half-life-ish factor for the rolling baseline (per frame, 0..1, small = slow). */
  baselineAlpha: number;
}

export const DEFAULT_TRIGGER_CFG: AudioTriggerCfg = {
  impulseFactor: 6,
  impulseMinRms: 0.05,
  refractoryMs: 5_000,
  sustainedMinRms: 0.02,
  sustainedMs: 8_000,
  baselineAlpha: 0.02,
};

export class AudioTrigger {
  #cfg: AudioTriggerCfg;
  #baseline = 0.005;        // rolling ambient RMS (starts at "quiet room")
  #energeticMs = 0;         // continuous ms at/above sustainedMinRms
  #sustainedFired = false;  // one sustained event per continuous stretch
  #lastFired: Partial<Record<AudioTriggerKind, number>> = {};

  constructor(cfg: AudioTriggerCfg = DEFAULT_TRIGGER_CFG) { this.#cfg = cfg; }

  /** Feed one frame's RMS. `inSpeech` = the VAD currently considers this an utterance
   *  (speech endpoints handle those; sustained must not double-fire on a long sentence —
   *  it requires the energy to OUTLAST normal speech). Returns a trigger or null. */
  frame(rms: number, frameMs: number, nowMs: number, inSpeech: boolean): AudioTriggerKind | null {
    const c = this.#cfg;
    // impulse FIRST, against the pre-update baseline (the jump itself must not have
    // already raised the bar it is measured against).
    let fired: AudioTriggerKind | null = null;
    if (rms >= Math.max(this.#baseline * c.impulseFactor, c.impulseMinRms)
        && nowMs - (this.#lastFired.impulse ?? -Infinity) >= c.refractoryMs
        && !inSpeech) {
      // a loud onset mid-utterance is part of the utterance; the endpoint covers it.
      this.#lastFired.impulse = nowMs;
      fired = 'impulse';
    }
    // rolling baseline (slow EMA) — tracks the room's ambient level.
    this.#baseline = this.#baseline * (1 - c.baselineAlpha) + rms * c.baselineAlpha;
    // sustained-energy stretch bookkeeping.
    if (rms >= c.sustainedMinRms) {
      this.#energeticMs += frameMs;
      if (!this.#sustainedFired && this.#energeticMs >= c.sustainedMs
          && nowMs - (this.#lastFired.sustained ?? -Infinity) >= c.refractoryMs) {
        this.#sustainedFired = true;
        this.#lastFired.sustained = nowMs;
        if (!fired) fired = 'sustained';
      }
    } else {
      this.#energeticMs = 0;
      this.#sustainedFired = false; // stretch ended → the next long stretch may fire again
    }
    return fired;
  }
}
