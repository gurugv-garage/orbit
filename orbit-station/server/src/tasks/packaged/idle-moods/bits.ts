/**
 * The idle-moods BIT TABLE — pure data. A bit is one short performance (a few seconds):
 * a named faceGestures choreography OR an explicit step script, optionally carrying a
 * `thought` prompt (a spoken line, subject to the picker's speak gate). Adding a mood
 * flavor = adding rows here, not code. Picked by picker.ts (pure, tested).
 *
 * Motion notes: the body is 2 DOF — foot (pan ±90°) + neck (tilt −60°=up … +35°=down).
 * Scripts are gentle and END NEAR HOME. Choreography lessons baked in (2026-07-05 critic
 * pass): anticipation beats (a sigh needs the inhale), irregular timing (even tempo reads
 * as a servo glitch), few direction reversals (servo buzz is the room's soundscape), and
 * stillness as part of the act (the freeze sells the joke).
 *
 * Thought prompts: scenario only — the task appends the shared STYLE guard (brevity, no
 * tic openers, the "stay silent if nothing fresh" escape hatch). No injected topics:
 * variety comes from real perception/memory or not at all.
 */

export type MoodName = 'bored' | 'curious' | 'attention' | 'sleepy' | 'flavor';

/** One timed move step (mirrors the `move` capability's step shape). */
export interface BitStep {
  parts: Array<{ part: 'foot' | 'neck'; degrees: number }>;
  duration_ms?: number;
  wait_ms?: number;
  relative?: boolean;
}

export interface Bit {
  id: string;                 // 'bored.fidget', 'flavor.existential', …
  mood: MoodName;
  weight: number;             // relative weight inside the eligible pool
  needsFace?: boolean;        // only eligible while someone is visibly present
  needsNoFace?: boolean;      // only eligible while NOBODY is visible (lonely must not lie)
  gesture?: string;           // a faceGestures name ('curious', 'sleepy', …) → `gesture` cap
  steps?: BitStep[];          // OR an explicit script
  thought?: string;           // a self-thought scenario → `think` cap (brain authors the line)
  /** a REACTIVE bit: its spoken line is a reaction to a HAPPENING — the picker requires
   *  a salient perception event within freshEventMaxMs, else the bit is ineligible
   *  (boredom-on-coherence: spontaneous self-talk is event-triggered, never scheduled —
   *  docs/research/idle-cognition.md principle 2, made MECHANICAL). Social bids
   *  (seek/lonely/attention) are presence-driven, not event-driven — they stay un-gated. */
  reactive?: boolean;
  /** a SEEK bit: the steps are a search sweep — after it, the task re-checks the camera.
   *  Found someone → a delighted gesture instead of the thought (the payoff writes itself);
   *  still nobody → the thought fires (subject to the speak gate), e.g. calling out. */
  seek?: boolean;
}

/** Style guard appended to every spoken-bit scenario (kept here with the bit data so a
 *  bench can reproduce the EXACT prompt a live bit sends). */
export const SPEAK_STYLE = ' A short FRAGMENT beats a sentence ("huh, new chair" over "I notice there is a new'
  + ' chair") — inner speech is condensed; save full sentences for genuinely striking moments. Under 12 words,'
  + ' no "Ah,"/"Well,"/"Hmm," openers, no exclamation overload, plain everyday words — no poetic imagery.'
  + ' If nothing actually happened worth reacting to, staying silent is the RIGHT choice: reply with'
  + ' NOTHING AT ALL — an empty reply. Never write the word "silence" or any placeholder, and never'
  + ' fall back to describing scenery that was already there.';

/** The full self-thought text for a spoken bit: the scenario + the style guard. NO
 *  artificial angle seeds (removed 2026-07-06, bench r4): injected random topics are an
 *  unnatural variety mechanism — every line orbited the seed (the dust and weekend
 *  epidemics, bench r1/r2) instead of the world. Variety must come from REAL inputs —
 *  the attached camera frame, the heard sounds, the day's memory, the time — and when
 *  the world offers nothing new, the honest output is SILENCE (the style guard's escape
 *  hatch). Speech rate tracking environment richness IS the realistic behavior. */
export function thoughtPrompt(bit: Bit): string {
  return `${bit.thought}${SPEAK_STYLE}`;
}

export const BITS: Bit[] = [
  // ── bored — restless small motion, mostly silent ─────────────────────────────
  {
    id: 'bored.fidget', mood: 'bored', weight: 3,
    // irregular amplitudes + pauses — a fidget, not a metronome.
    steps: [
      { parts: [{ part: 'foot', degrees: 9 }], duration_ms: 700, wait_ms: 500, relative: true },
      { parts: [{ part: 'foot', degrees: -13 }], duration_ms: 1100, wait_ms: 1400, relative: true },
      { parts: [{ part: 'foot', degrees: 4 }], duration_ms: 600, relative: true },
    ],
  },
  {
    id: 'bored.sigh', mood: 'bored', weight: 2,
    // anticipation: the inhale lift, the heavy droop, the failed recovery, resignation.
    steps: [
      { parts: [{ part: 'neck', degrees: -8 }], duration_ms: 700 },
      { parts: [{ part: 'neck', degrees: 28 }], duration_ms: 1600, wait_ms: 1200 },
      { parts: [{ part: 'neck', degrees: 22 }], duration_ms: 400, wait_ms: 800 },
      { parts: [{ part: 'neck', degrees: 0 }], duration_ms: 1200 },
    ],
  },
  {
    id: 'bored.slow-look', mood: 'bored', weight: 3,
    steps: [
      { parts: [{ part: 'foot', degrees: -35 }], duration_ms: 1800, wait_ms: 700 },
      { parts: [{ part: 'foot', degrees: 35 }], duration_ms: 2600, wait_ms: 700 },
      { parts: [{ part: 'foot', degrees: 0 }], duration_ms: 1400 },
    ],
  },
  {
    id: 'bored.muse', mood: 'bored', weight: 1, reactive: true,
    // boredom research (docs/research/idle-cognition.md §5): boredom is a PUSH to engage,
    // not a state to narrate — the line must be it FINDING something, or nothing at all.
    thought: 'You are bored — which is really an itch to find something engaging. Look at what you can '
      + 'currently see and hear: if anything at all offers a spark of interest — something that happened, '
      + 'changed, or you had not noticed before — react to it in a few words. Do not announce that you are '
      + 'bored; if nothing genuinely engages you, stay silent.',
  },
  {
    id: 'bored.seek-company', mood: 'bored', weight: 2, needsNoFace: true, seek: true,
    // a deliberate LOOK-FOR-PEOPLE sweep (slow, dwelling at each side so perception can
    // catch a face). Found someone → delighted surprise, and face-follow locks on after
    // release. Nobody → maybe call out (speak-gated, so it stays rare and endearing).
    steps: [
      { parts: [{ part: 'foot', degrees: -60 }, { part: 'neck', degrees: -10 }], duration_ms: 2200, wait_ms: 1200 },
      { parts: [{ part: 'foot', degrees: 60 }], duration_ms: 3200, wait_ms: 1200 },
      { parts: [{ part: 'foot', degrees: 0 }, { part: 'neck', degrees: 0 }], duration_ms: 1600 },
    ],
    thought: 'You are a bit bored and just looked around the room for company — nobody there. '
      + 'Call out once, warmly and briefly, asking if anyone is around for a chat.',
  },

  // ── curious — look at the world, occasionally wonder aloud ───────────────────
  { id: 'curious.tilt', mood: 'curious', weight: 3, gesture: 'curious' },
  {
    id: 'curious.peek', mood: 'curious', weight: 2,
    steps: [
      { parts: [{ part: 'foot', degrees: 25 }, { part: 'neck', degrees: -15 }], duration_ms: 1200, wait_ms: 2200 },
      { parts: [{ part: 'foot', degrees: 0 }, { part: 'neck', degrees: 0 }], duration_ms: 1000 },
    ],
  },
  {
    id: 'curious.fly-watch', mood: 'curious', weight: 2,
    // tracking an invisible fly, then losing it — comedy from timing variance + the
    // stare-at-nothing beat.
    steps: [
      { parts: [{ part: 'foot', degrees: 20 }, { part: 'neck', degrees: -25 }], duration_ms: 500, wait_ms: 400 },
      { parts: [{ part: 'foot', degrees: -15 }, { part: 'neck', degrees: -35 }], duration_ms: 400, wait_ms: 200 },
      { parts: [{ part: 'foot', degrees: 5 }, { part: 'neck', degrees: -18 }], duration_ms: 350, wait_ms: 150 },
      { parts: [{ part: 'foot', degrees: -28 }, { part: 'neck', degrees: -30 }], duration_ms: 500, wait_ms: 1500 },
      { parts: [{ part: 'foot', degrees: 0 }, { part: 'neck', degrees: 0 }], duration_ms: 1100 },
    ],
  },
  {
    id: 'curious.wonder', mood: 'curious', weight: 1, reactive: true,
    // SEE or HEAR: the camera view is often static (the head parks somewhere), but the mic
    // hears everything — the room's sounds are where the variety lives. Activities in
    // plain view/earshot (a game, dancing, laughter, music) are fair game; appearance,
    // screen contents, and quoting people's words back stay off-limits.
    thought: 'Something JUST HAPPENED or changed around you and it caught your attention — a sound, a '
      + 'movement, a lively activity (a game, music, laughter, a commotion), something new in view. One short '
      + 'curious or delighted reaction to that happening. Standing scenery that was already there does not '
      + 'count. Never about someone\'s appearance or their screen, and never quote or repeat anyone\'s '
      + 'words back.',
  },

  // ── attention — someone is around but nobody is talking to you ───────────────
  // (the picker allows ONE attention bit per presence stretch — offers once, lets it go)
  { id: 'attention.perk', mood: 'attention', weight: 3, needsFace: true, gesture: 'excited' },
  {
    id: 'attention.double-take', mood: 'attention', weight: 2, needsFace: true,
    // gazing elsewhere, drifting back bored, SNAP — you're still here? (face-follow
    // resuming after release holds the stare: a free button on the joke.)
    steps: [
      { parts: [{ part: 'foot', degrees: 45 }], duration_ms: 1800, wait_ms: 900 },
      { parts: [{ part: 'foot', degrees: 15 }], duration_ms: 1400, wait_ms: 250 },
      { parts: [{ part: 'foot', degrees: 0 }], duration_ms: 200, wait_ms: 1200 },
    ],
  },
  {
    id: 'attention.bid', mood: 'attention', weight: 1, needsFace: true,
    // a light INVITATION aimed at the person (bench r2: plain observations tested as
    // flat non-bids) — but never needy, never mentions being ignored.
    thought: 'Someone has been nearby for a while but nobody is talking to you. Make one light, friendly BID for interaction — invite them to chat, ask a tiny question, or offer to help with what they seem busy with. It must be an invitation aimed at them, not a comment about the room.',
  },

  // ── sleepy — quiet-hours wind-down (never speaks; picker enforces it too) ────
  { id: 'sleepy.droop', mood: 'sleepy', weight: 2, gesture: 'sleepy' },
  {
    id: 'sleepy.nod-off', mood: 'sleepy', weight: 2,
    steps: [
      { parts: [{ part: 'neck', degrees: 30 }], duration_ms: 2600, wait_ms: 4000 },
      { parts: [{ part: 'neck', degrees: 18 }], duration_ms: 1200, wait_ms: 1500 },
      { parts: [{ part: 'neck', degrees: 28 }], duration_ms: 1600 },
    ],
  },
  {
    id: 'sleepy.stir', mood: 'sleepy', weight: 4,
    // sleep is mostly STILLNESS — a long, barely-moving stir that soaks up night cycles
    // so the night doesn't become 300 performances.
    steps: [
      { parts: [{ part: 'neck', degrees: 32 }], duration_ms: 3000, wait_ms: 9000 },
      { parts: [{ part: 'foot', degrees: 6 }], duration_ms: 2500, wait_ms: 7000, relative: true },
      { parts: [{ part: 'foot', degrees: -6 }], duration_ms: 2500, relative: true },
      { parts: [{ part: 'neck', degrees: 0 }], duration_ms: 2500 },
    ],
  },

  // ── flavor — rare spice on the same machinery ────────────────────────────────
  {
    id: 'flavor.existential', mood: 'flavor', weight: 1,
    thought: 'A brief existential flicker: you are a small desk robot. One wry, lighthearted musing about YOUR OWN '
      + 'little existence — your job, your view, your day — hooked to a tiny concrete thing near you (e.g. "I have '
      + 'watched this staircase all day; I think guarding it is my calling"). The musing must be about YOU, not a '
      + 'plain remark about the room. Never consciousness, dreams, or "just a robot" clichés. Charming, not dark.',
  },
  {
    id: 'flavor.puzzled', mood: 'flavor', weight: 1, gesture: 'concerned',
    // MOTION-ONLY: its spoken lines benched incoherent (r1) — puzzlement is a head-tilt,
    // not a sentence.
  },
  {
    id: 'flavor.lonely', mood: 'flavor', weight: 1, needsNoFace: true,
    thought: 'It has been quiet and nobody has been around for a while. One short, wistful but endearing line '
      + 'about the quiet.',
  },
];
