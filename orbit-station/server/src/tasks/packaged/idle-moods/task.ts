/**
 * # idle-moods
 * The dock's idle personality — short episodic "bits" (bored fidgets, curious looks,
 * attention bids, sleepy droops, rare flavor lines) performed while nothing else is
 * going on. Conducted by the per-dock conductor (`moods` in conducted.ts): the conductor
 * decides WHEN this task runs (conversation-idle window); THIS task decides WHICH mood
 * fits (picker.ts, pure) and performs it.
 *
 * Body etiquette: unlike face-follow (a continuous holder at 30), a bit ACQUIRES the
 * body at priority 35 for just the seconds it performs, then RELEASES — so between bits
 * face-follow tracks normally, and during a bit it yields (its own proven yield/resume).
 * A brain turn (60) / console (70) preempts a bit mid-step; we notice via bodyHeld and
 * abandon the bit gracefully. Spoken bits go through the `think` capability — the brain
 * authors + speaks the line with its own context (rate-capped here AND floored station-side).
 */
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';
import { BITS, thoughtPrompt, type Bit } from './bits.js';
import { inQuietHours, pickBit, type MoodCfg } from './picker.js';

export const manifest = {
  name: 'idle-moods',
  description: 'Idle personality bits — bored/curious/attention/sleepy/flavor micro-performances '
    + 'while the dock is otherwise idle. Normally started by the conductor (which passes its '
    + 'tunings); safe to run manually. Loops until stopped.',
  params: [
    // cadence: real creatures are mostly STILL — a metronomic twitch every minute reads as
    // a scanner, not a mood (2026-07-05 lived-with critique). Quiet hours stretch this 3×.
    { name: 'bitMinMs', type: 'number', required: false, default: 180_000 },      // min gap between bits (3 min)
    { name: 'bitMaxMs', type: 'number', required: false, default: 480_000 },      // max gap between bits (8 min)
    { name: 'speakMinGapMs', type: 'number', required: false, default: 3_600_000 }, // ≥1 h between spoken bits
    { name: 'speakIdleMinMs', type: 'number', required: false, default: 600_000 }, // ≥10 min after a conversation
    { name: 'quietStartHour', type: 'number', required: false, default: 22 },
    { name: 'quietEndHour', type: 'number', required: false, default: 7 },
    { name: 'attentionAfterMs', type: 'number', required: false, default: 180_000 },
    { name: 'freshEventMaxMs', type: 'number', required: false, default: 180_000 }, // reactive bits need a happening this recent
    { name: 'activateAfterMs', type: 'number', required: false, default: 300_000 }, // the conductor's idle gate (for the conversation-distance floor)
    { name: 'wBored', type: 'number', required: false, default: 1 },
    { name: 'wCurious', type: 'number', required: false, default: 1 },
    { name: 'wAttention', type: 'number', required: false, default: 0.5 },
    { name: 'wSleepy', type: 'number', required: false, default: 1 },
    { name: 'wFlavor', type: 'number', required: false, default: 0.08 },
  ],
} satisfies TaskManifest;

const MOOD_PRIORITY = 35;           // > face-follow 30 (a bit briefly preempts the reflex), < brainTurn 60
const PRESENCE_GRACE_MS = 12_000;   // face flicker tolerance for the continuous-presence clock
// The shared STYLE guard for every spoken bit: brevity, no LLM tic openers, and the
// silence escape hatch (the LLM as its own quality gate — quiet beats filler). A random
// concrete ANGLE seed forces line-to-line divergence (identical prompts converge on the
// model's three modal quips by the 50th occurrence).

class IdleMoodsTask extends Task {
  async run(): Promise<void> {
    const n = (k: string, d: number) => (typeof this.params[k] === 'number' ? (this.params[k] as number) : d);
    const cfg: MoodCfg = {
      quietStartHour: n('quietStartHour', 22), quietEndHour: n('quietEndHour', 7),
      attentionAfterMs: n('attentionAfterMs', 180_000),
      speakMinGapMs: n('speakMinGapMs', 3_600_000), speakIdleMinMs: n('speakIdleMinMs', 600_000),
      freshEventMaxMs: n('freshEventMaxMs', 180_000),
      weights: {
        bored: n('wBored', 1), curious: n('wCurious', 1), attention: n('wAttention', 0.5),
        sleepy: n('wSleepy', 1), flavor: n('wFlavor', 0.08),
      },
    };
    // floor the gap so a degenerate tuning (bitMinMs 0) can't become a sleep(0) hot loop
    // hammering the WS + the lease — 3 s still allows fast live-testing.
    const bitMinMs = Math.max(n('bitMinMs', 180_000), 3_000);
    const bitMaxMs = Math.max(n('bitMaxMs', 480_000), bitMinMs);
    const activateAfterMs = n('activateAfterMs', 300_000);

    // The conductor starts us only after ≥activateAfterMs of conversation-idle and kills us
    // the moment a conversation starts — so "ms since conversation" is AT LEAST the idle gate
    // plus our own age (a lower bound: the true idle stretch may be longer; being conservative
    // only delays speech, never rushes it).
    const startedAt = Date.now();
    // Spoken-bit clock. Persisted via checkpoint so a same-instance resume keeps the gap; a
    // FRESH instance starts at 0 and the conversation-distance + station-side floor still guard.
    let lastSpokeAt = typeof this.state.lastSpokeAt === 'number' ? (this.state.lastSpokeAt as number) : 0;
    // continuous-presence clock (for attention bits): first-seen epoch + last-seen for grace.
    let presentSince = 0;
    let lastSeenAt = 0;
    let lastBitId: string | null = null;   // anti-tic: never the same bit twice in a row
    let attentionSpent = false;            // one attention bit per presence stretch

    while (true) {
      // sleep the jittered gap — 3× longer during quiet hours (sleep is mostly stillness).
      const gap = bitMinMs + Math.random() * (bitMaxMs - bitMinMs);
      const quietNow = inQuietHours(new Date().getHours(), cfg.quietStartHour, cfg.quietEndHour);
      await this.sleep(Math.round(quietNow ? gap * 3 : gap));

      const faces = await this.faces();
      // boredom-on-coherence: how long since the world offered a genuine happening?
      const pulse = await this.request<{ msSinceSalient: number | null }>('perception-pulse')
        .catch(() => ({ msSinceSalient: null }));
      const now = Date.now();
      if (faces > 0) { if (presentSince === 0) presentSince = now; lastSeenAt = now; }
      else if (presentSince !== 0 && now - lastSeenAt > PRESENCE_GRACE_MS) {
        presentSince = 0;
        attentionSpent = false;            // presence lapsed → the next arrival earns a fresh offer
      }

      const pick = pickBit({
        hourLocal: new Date().getHours(),
        facesPresent: presentSince !== 0,
        msPresentContinuous: presentSince === 0 ? 0 : now - presentSince,
        msSinceConversation: activateAfterMs + (now - startedAt),
        msSinceLastSpoke: lastSpokeAt === 0 ? Number.MAX_SAFE_INTEGER : now - lastSpokeAt,
        msSinceSalient: pulse?.msSinceSalient ?? null,
        lastBitId, attentionSpent,
        rand: Math.random,
      }, cfg, BITS);
      if (!pick) { this.status('nothing eligible this cycle'); continue; }

      // Only a MOTION bit needs the body — a thought-only bit must keep speaking even when
      // the servo is offline/busy (with the body down, acquire failures were silencing ALL
      // bits including pure speech — seen live 2026-07-05). A bit with motion is a SHORT
      // exclusive hold: acquire → perform → release; denied → skip, next cycle retries.
      const needsBody = !!(pick.bit.gesture || pick.bit.steps?.length);
      let heldBody = false;
      if (needsBody) {
        const got = await this.request<{ ok: boolean }>('acquireBody', { priority: MOOD_PRIORITY }).catch(() => null);
        if (!got?.ok) { this.status('body busy/offline — skipped a bit'); continue; }
        heldBody = true;
      }
      console.log(`[mood] ts=${now} bit=${pick.bit.id} speak=${pick.speak} faces=${faces}`);
      this.status(`performing ${pick.bit.id}${pick.speak ? ' + speaking' : ''}`);
      try {
        if (needsBody) await this.perform(pick.bit);
        // SEEK payoff: the sweep was a search for people — re-check the camera. Found
        // someone → delighted surprise instead of calling out (and face-follow locks on
        // once we release). Still nobody → fall through to the speak-gated call-out.
        let foundCompany = false;
        if (pick.bit.seek) {
          foundCompany = (await this.faces()) > 0;
          if (foundCompany) {
            console.log('[mood] seek found company — delighted');
            const r = await this.request<{ ok: boolean; durationMs?: number }>('gesture', { expression: 'surprised' })
              .catch(() => null);
            if (r?.ok) await this.holdBodyThrough(r.durationMs ?? 3000);
          }
        }
        if (pick.speak && pick.bit.thought && !foundCompany) {
          const ok = await this.request<{ ok: boolean }>('think',
            { text: thoughtPrompt(pick.bit), coalesceKey: 'mood', via: `mood:${pick.bit.id}` })
            .then((r) => !!r?.ok).catch(() => false);
          if (ok) { lastSpokeAt = Date.now(); this.state.lastSpokeAt = lastSpokeAt; this.checkpoint(); }
        }
      } finally {
        if (heldBody) await this.request('releaseBody').catch(() => { /* TTL frees it anyway */ });
      }
      lastBitId = pick.bit.id;
      if (pick.bit.mood === 'attention') attentionSpent = true;
      this.status(`last bit: ${pick.bit.id}${pick.speak ? ' (spoke)' : ''}`);
    }
  }

  /** Play the bit's motion: a named gesture, or its step script — RENEWING the body lease
   *  through every wait via the shared holdBodyThrough (a step's travel can outlive the
   *  1.5 s lease TTL; without renewal the hold expires mid-step and face-follow
   *  legitimately steals the body — seen live). The gesture path holds for the EXECUTOR'S
   *  paced estimate (authored sums under-count stretched fast gestures 2×+). A genuine
   *  preempt (brain turn / console) → abandon the rest, don't fight. */
  private async perform(bit: Bit): Promise<void> {
    if (bit.gesture) {
      const r = await this.request<{ ok: boolean; durationMs?: number }>('gesture', { expression: bit.gesture })
        .catch(() => null);
      // hold + renew until the fire-and-forget choreography actually finishes.
      if (r?.ok) await this.holdBodyThrough(r.durationMs ?? 3000);
      return;
    }
    for (const step of bit.steps ?? []) {
      await this.move([step]).catch(() => {});
      const done = await this.holdBodyThrough((step.duration_ms ?? 500) + (step.wait_ms ?? 0));
      if (!done) { console.log('[mood] preempted mid-bit — abandoning'); return; }
    }
  }

  /** How many faces are visible right now (0 on any error — a glitch reads as "absent",
   *  which only makes attention bits rarer, never wrong). */
  private async faces(): Promise<number> {
    return (await this.trackFaces()).length;
  }

  getStatus(): string { return 'idle-moods'; }
}

runTask(IdleMoodsTask);
