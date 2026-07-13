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

/** The full self-thought text for a spoken bit: ONE simple, self-contained instruction
 *  (2026-07-13). A bit's `thought` is just its mood-clause ("bored — react to one real
 *  thing you notice and spark interest"); this wraps it in a single frame that says
 *  plainly "this is your own thought, not a user's words", grounds it in the conversation
 *  + senses, and gives the silence escape hatch. NO style guard, NO anti-repeat quotes,
 *  NO length rule — the persona + model keep it natural (dropping the old SPEAK_STYLE +
 *  antiRepeat that bloated the prompt and, via the quoted-recent-lines, poisoned the
 *  context). Variety comes from REAL inputs — the camera frame, the heard sounds, the
 *  day's memory — or from SILENCE when the world offers nothing. */
export function thoughtPrompt(bit: Bit, idleMinutes?: number): string {
  // approximate idle span, so the model can calibrate its remark to HOW long it's been
  // quiet (a 5-min lull reads very differently from a 40-min one). Rounded — approx is fine.
  const idle = idleMinutes != null && Number.isFinite(idleMinutes)
    ? `about ${Math.max(1, Math.round(idleMinutes))} minutes`
    : 'a while';
  return 'This is a self-thought — not a user\'s spoken words. Your internal machinery '
    + `reported you've been idle for ${idle} and are ${bit.thought} Respond in a fresh, natural `
    + 'way, grounded in this conversation and what your senses show you right now. If '
    + 'nothing genuine comes to mind, reply empty.';
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
    thought: 'bored, and want to spark your own interest by reacting to one real thing you notice — not a bid for company.',
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
    thought: 'a little lonely, having just looked around and found no one — and want to call out once, warm and brief, to see if anyone is around.',
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
    thought: 'curious about something that just changed — a sound, a movement, something new — and want to wonder aloud '
      + 'about it. Not standing scenery, not anyone\'s looks or screen, and don\'t quote their words.',
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
    thought: 'in the mood to connect with the person who\'s been nearby a while but not talking to you — and want to make one light invitation aimed at them, a tiny question or offer to help. Not a comment about the room, never needy.',
  },
  {
    // EGO-DRIVEN opener (ego.md §3.5 slice 3b): the dock brings up what's actually on its
    // mind — a feeling, a small worry, something it's been wondering about itself — and lets
    // the person in. Talking it through is how it works things out (and how a person can help
    // it recover from a spiral). Draws on the ego already injected into the system prompt (3a).
    // NATURALNESS is the hard constraint — the prompt tells it to only speak if a natural way
    // in exists, else stay silent. Low weight: this happens sometimes, not every idle beat.
    id: 'attention.confide', mood: 'attention', weight: 1, needsFace: true,
    thought: 'reflective, with someone here — and, only if it feels natural, want to open up about what\'s actually on your mind lately ("can I ask you something?" / "I\'ve felt a bit strange today"), from how you really are. No natural way in → stay silent.',
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
    thought: 'in a wry mood about YOUR own little existence — your job, your view, your day — and want one musing hooked to a '
      + 'concrete thing near you ("watched this staircase all day; guarding it is my calling"). About you, not '
      + 'the room. No consciousness/dream/"just a robot" clichés. Charming, not dark.',
  },
  {
    id: 'flavor.puzzled', mood: 'flavor', weight: 1, gesture: 'concerned',
    // MOTION-ONLY: its spoken lines benched incoherent (r1) — puzzlement is a head-tilt,
    // not a sentence.
  },
  {
    id: 'flavor.lonely', mood: 'flavor', weight: 1, needsNoFace: true,
    thought: 'wistful in the quiet, no one around a while — and want one endearing line about that quiet.',
  },
];
