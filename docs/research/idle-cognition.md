# How humans think when idle — and what it means for the dock's idle behavior

> **RESEARCH STUDY** (2026-07-06). Question: what does idle human cognition actually
> consist of — and what does it teach the design of orbit's idle-moods behavior?
> Method: deep-research harness (5 search angles → source fetch → 3-vote adversarial
> verification per claim). Verification was cut short by a session rate limit: 9 claims
> fully verified (votes shown), 2 refuted, ~14 rate-limited before their votes
> (marked UNVERIFIED — single-source, credible venues, treat as leads not facts).
> The synthesis below is hand-written from the surviving evidence.
>
> Consumer: [idle-moods](../../orbit-station/server/src/tasks/packaged/idle-moods/) +
> the conductor's moods tunings; the perception→brain self-thought lane.

## Verified findings (3-vote adversarial, votes shown)

1. **Most idle thought is not verbal.** Random-moment experience sampling finds inner
   speech in only ~20–25% of samples — far below questionnaire estimates; and audible
   private speech is rarer still than silent inner speech in adults. (3-0, 3-0;
   Hurlburt DES work, PMC4538954; Latinjak et al. 2023)
2. **Spontaneous self-talk is event-triggered, not scheduled.** It is an unintentional,
   uncontrolled process provoked by ongoing events and emotional reactions, and its
   function is awareness-raising ("I love those clouds!") — distinct from goal-directed
   self-talk (controlled self-regulation). (3-0; Latinjak et al. 2023)
3. **Inner speech is condensed by default** — fragments, not sentences — and expands
   toward fuller (potentially overt) speech under stress and cognitive challenge. (2-1)
4. **Aloneness increases self-talk.** Loneliness correlates positively with self-talk
   frequency (r = 0.29); adult only-children self-talk more (d = 0.28 overall, 0.46
   self-critical). Isolation raises, not suppresses, self-directed speech. (3-0, 3-0;
   Frontiers in Psychology 2019)
5. **What gates overt vs silent self-talk is an acknowledged OPEN QUESTION in the
   field.** (3-0) — there is no scientific recipe to copy for a speak-gate; we design it.
6. **Boredom is a motivated state, not an absence.** Across psychodynamic, existential,
   arousal, and cognitive theories: "the aversive experience of wanting, but being
   unable, to engage in satisfying activity" — a PUSH toward engagement. (3-0;
   Eastwood et al. 2012)
7. **Boredom is an attentional failure on BOTH channels** — inability to engage with
   internal (thoughts/feelings) OR external (environment) information. Both are
   legitimate engagement targets whose joint failure produces boredom. (3-0)

## Refuted (2/3 votes against)

- ~~"Social presence gates audible self-talk"~~ — did not survive verification (1-2).
  Consistent with #5: the gating conditions are genuinely unknown.
- ~~"Idle thought content is dominated by emotion/planning, not environment
  commentary"~~ — did not survive (1-2). Remarking on the surroundings is legitimate
  spontaneous-thought content, not an artifact.

## Unverified leads (rate-limited before votes — single-source, credible venues)

- Boredom as **homeostatic information-hunger**: a regulatory signal that current
  activity stopped yielding information; discharges into *unspecific exploration* —
  satisfiable by nearly any information-yielding action (PMC11669060; Nature Comms
  Psychology s44271-025-00209-6).
- **MAC model**: boredom discharges via four routes — switch activities, re-value the
  goal, adjust cognitive demand, or adjust mental content (Westgate).
- Induced boredom → increased desire for challenge → actual challenge-seeking
  (preregistered, N=297); challenge-seeking both relieves and PREVENTS boredom.
- HRI: **slow idle head motion** rated significantly more anthropomorphic and more
  intelligent than fast (Buddy robot, arXiv 2209.00983); **meaningful motions** elicit
  stronger social responses than non-meaningful idle motions (social verification).

## Gaps (searches failed; re-run when quota allows)

Mind-wandering temporal dynamics (thought frequency/duration/drift) and the
past/future/self content distribution — the two search agents died mid-response.
The DMN literature is uncontroversial background; the specific numbers would refine
pacing but don't change the principles below.

## Design principles for idle-moods (mapped to implementation)

1. **Mostly non-verbal, by a wide margin.** Humans verbalize ≤20-25% of idle thought,
   and voice less than they verbalize. → The speech gate's rarity (≥1 h default between
   lines) is directionally right; the idle repertoire is stillness, glances, posture.
   *(Already built: speak gates + mostly-motion bit table.)*
2. **Remarks react to events, not timers.** Spontaneous self-talk is provoked by
   something happening. A scheduled "now say something bored" is the anti-pattern —
   the roll may be scheduled, but the LINE must be a reaction to something recent, and
   silence is the honest output of an eventless world. *(Applied: muse/wonder prompts
   now demand a recent happening/change; the silence hatch already exists. Future:
   prefer firing spoken bits when perception shows a fresh change/salient sound.)*
3. **Fragments over sentences.** Condensed is the default register of inner speech;
   full sentences signal genuine salience. *(Applied: style guard now prefers
   fragments; the 12-word cap stays as the ceiling, not the target.)*
4. **Talking to itself alone is realistic.** Aloneness raises self-talk — a solitary
   mutter needs no audience, and the lonely/seek behaviors are grounded in real
   psychology. *(Already built: seek-company, flavor.lonely.)*
5. **Boredom discharges as exploration, not complaint.** It's a push to engage —
   switch activity, seek information, seek challenge — not a state to narrate.
   *(Applied: bored.muse reshaped from "say a line about being bored" to
   "find something engaging or stay silent"; seek-company and slow-look are the
   discharge shapes the MAC model predicts.)*
6. **Slow, meaningful motion.** HRI evidence favors slow idle head motion and
   motivated (non-random) movement for perceived aliveness and intelligence.
   *(Already built: the 2026-07-05 choreography pass — slow, motivated, stillness as
   part of the act.)*
7. **The speak-gate is ours to design.** Science has no answer for what makes a
   thought surface aloud — so behavioral tuning (rate caps, salience thresholds) is
   legitimate design space, not a fidelity violation.

## Update log

- 2026-07-06 — initial study (deep-research harness wf_9539a2a2; 9 verified /
  2 refuted / ~14 rate-limited). Principles 2, 3, 5 applied to bits.ts same day.
- 2026-07-06 — bench rounds r5/r6 (mood-line-bench) validated the applied principles:
  static grounding → wonder/existential correctly SILENT; eventful grounding → reactive
  fragments ("Someone spoke, but I see no one"; "Still laughing? That's nice to hear").
  r5 exposed that "stay silent" needs a MECHANISM (the model wrote the literal word
  "Silence.") — the style guard now says an EMPTY reply is the correct output. Residual
  soft spot: bored.muse occasionally narrates standing scenery instead of going silent.
