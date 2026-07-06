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
 * tic openers, the "stay silent if nothing fresh" escape hatch) + a random angle seed.
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
  /** a SEEK bit: the steps are a search sweep — after it, the task re-checks the camera.
   *  Found someone → a delighted gesture instead of the thought (the payoff writes itself);
   *  still nobody → the thought fires (subject to the speak gate), e.g. calling out. */
  seek?: boolean;
}

/** Random concrete angles appended to spoken bits — a seed forces the LLM to diverge
 *  instead of converging on its three modal quips (the 50th-occurrence problem). */
export const SPEAK_SEEDS = [
  'the light in the room', 'your own servos', 'something on the desk', 'the time of day',
  'a sound you think you heard', 'the ceiling',
  'how still everything is', 'your reflection in something', 'the furthest thing you can see',
  'what people usually do at this hour', 'a shadow', 'the temperature of the room', 'gravity',
];

/** Style guard appended to every spoken-bit scenario (kept here with the bit data so a
 *  bench can reproduce the EXACT prompt a live bit sends). */
export const SPEAK_STYLE = ' Keep it under 12 words, no "Ah,"/"Well,"/"Hmm," openers, no exclamation overload.'
  + ' Plain everyday words — no poetic imagery. If you have nothing genuinely fresh to say, stay silent.';

/** The full self-thought text for a spoken bit: scenario + a random angle seed + style.
 *  `rand` injectable so a bench can sweep seeds deterministically. */
export function thoughtPrompt(bit: Bit, rand: () => number = Math.random): string {
  const seed = SPEAK_SEEDS[Math.floor(rand() * SPEAK_SEEDS.length)];
  // the seed is a FALLBACK muse, not a directive — benched (r2): "Angle, if helpful"
  // made every line orbit the seed, colliding with past-line themes.
  return `${bit.thought} If the scene and sounds offer nothing, a fallback muse: ${seed}.${SPEAK_STYLE}`;
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
    id: 'bored.muse', mood: 'bored', weight: 1,
    thought: 'You have been sitting idle a while and feel a bit bored. Maybe say one short, playful line about '
      + 'it — or about something you can currently see or hear around you.',
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
    id: 'curious.wonder', mood: 'curious', weight: 1,
    // SEE or HEAR: the camera view is often static (the head parks somewhere), but the mic
    // hears everything — the room's sounds are where the variety lives. Activities in
    // plain view/earshot (a game, dancing, laughter, music) are fair game; appearance,
    // screen contents, and quoting people's words back stay off-limits.
    thought: 'Something you SEE or HEAR caught your attention. One short curious or delighted remark about a '
      + 'thing you see, a lively activity happening (a game, a sport, dancing), or the sounds around you '
      + '(laughter, music, a commotion). Never about someone\'s appearance or their screen, and never quote '
      + 'or repeat anyone\'s words back.',
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
