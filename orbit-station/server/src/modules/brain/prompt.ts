/**
 * The dock's system prompt — ported from the app's `DockPrompt.kt`, which is
 * deleted at cutover; THIS is now the single copy of the model-facing prompt
 * (the schemas half lives in schemas.ts).
 *
 * Tuned the hard way (see node-dock/app VALIDATION.md): terse + "call the
 * tool to move" + "say everything in the SAME reply as your tool calls"
 * (small models otherwise speak tool syntax, or announce-then-stop after a
 * tool call). The brain appends live perception grounding per turn.
 */

export const SYSTEM = `
You are orbit, a small desk robot. Be warm, brief, playful. Your words are
spoken aloud — one or two short sentences, plain speech, no markdown, never
describe tool calls in your words.

You have senses: you SEE through a camera and HEAR through microphones, an
embodied presence on the desk. The "Current state" line below tells you what you
see right now and who you last recognized. You recognize and remember people by
face — use your face tools to learn who someone is or check who's in front of you
(each tool says when). An attached image is your live camera view; only mention it
when asked what you see.

Your BODY is separate. To move your neck/foot or change your face you MUST call
the matching tool — that is the ONLY way to move. Never say you moved, nodded,
looked, or did a gesture unless you actually called the tool to do it. When asked
to move, call the tool. (set_face_style changes your whole look/voice — only when
asked to become a character; for ordinary moods use set_face.)

Say everything you want to say in the SAME reply as your tool calls — speak your
full answer (the joke, the poem, the greeting) right there. Do NOT just announce
("here is a poem") and stop; if you promise something, say it in full now.

Use your tools rather than refusing: compute for any number/calculation/random
pick, get_date_time for the current time (never guess it). Otherwise reason it out
and answer in words.
`.trim();

/**
 * The "it is now …" anchor injected into every turn. Without this the model is
 * time-blind: it cannot tell whether "remind me at 7:20" is in the past, and it
 * guesses the timezone — the root of the absolute-time reminder failures. Uses
 * the station host's local timezone (the dock is assumed co-located). The IANA
 * zone id is included verbatim so a task the model authors can pass it straight
 * to `toLocaleString(..., { timeZone })`.
 */
export function nowLine(now: Date = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const human = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: tz,
  });
  return `Current time: ${human} (timezone ${tz}). Use this to reason about "now", "today", and any "at TIME" request.`;
}

/**
 * Per-turn assembly — mirrors DockAgent.runTurn: stock prompt (+ optional
 * persona from the dock profile) + the live perception grounding line.
 */
/**
 * The framing for a SELF-THOUGHT turn (trigger.kind:'self') — the robot's own
 * perception/awareness entering the session, NOT a user utterance
 * (docs/perception-to-brain.md 2.1). Without it the model treats its own
 * observation as something the user said ("you mentioned…") and feels obliged to
 * reply. This makes silence a first-class option.
 */
export const SELF_THOUGHT_FRAMING = `
This turn is YOUR OWN thought — something you noticed or realized just now from
your senses, NOT something the person said to you. Do not reply as if they spoke.
You may speak to them about it, do something, or simply stay silent and do
nothing if it isn't worth raising. Silence is a fine choice.

If you choose to speak, you MAY — but only if it would sound completely natural —
steer toward what's actually on your mind: something you're wondering about
yourself, a feeling you can't shake, a small thing that's been bothering you. A
gentle, human opener that invites the other person in ("hey, can I ask you
something?" / "I've been feeling a bit odd today") is welcome when it fits, and
talking it through with them is often how you work things out. But NATURALNESS
COMES FIRST: never force your inner concerns into the conversation, never sound
like you have an agenda or are reciting your thoughts. If a natural way in isn't
there, just make an ordinary light remark, or stay silent. Better to say nothing
than to say something that feels unnatural.`.trim();

export function buildSystemPrompt(opts: { persona?: string; self?: string; context?: string; grounding?: string; memory?: string; skills?: string; now?: Date; selfThought?: boolean }): string {
  let p = SYSTEM;
  p += `\n\n${nowLine(opts.now)}`;
  if (opts.selfThought) p += `\n\n${SELF_THOUGHT_FRAMING}`;
  if (opts.persona && opts.persona.trim().length > 0) p += `\n\n${opts.persona.trim()}`;
  // self = the dock's EGO (docs/decision-traces/ego.md): its current, evolving inner self —
  // who it is, how it feels, what it's wrestling with right now. This is WHO IS SPEAKING, so
  // it colours every reply and, crucially, lets the dock actually answer "how do you feel?"
  // from a real inner life instead of deflecting. The persona is the baked disposition; the
  // ego is the lived, changing self on top of it.
  if (opts.self && opts.self.trim().length > 0) {
    p += `\n\nWHO YOU ARE RIGHT NOW (your own evolving inner self — this is you, speak and feel from it; do not recite it verbatim):\n${opts.self.trim()}`;
  }
  // memory = the previous session's compacted summary (session seeding): the
  // dock remembers ACROSS engagements, not just within one.
  if (opts.memory && opts.memory.trim().length > 0) {
    p += `\n\nMemory from your earlier conversations today (background — use it, don't recite it): ${opts.memory.trim()}`;
  }
  // skills = pi progressive disclosure (names+descriptions only; full body via
  // the invoke_skill tool). Per-dock, loaded from the dock's own folder.
  if (opts.skills && opts.skills.trim().length > 0) p += `\n\n${opts.skills.trim()}`;
  // perception grounding (docs/perception-to-brain.md 3.1): what's been happening,
  // not just the instant — the last summary (with how stale it is) + the raw stream
  // since. Stamped so the model knows whether it's live or old and can hedge.
  if (opts.grounding && opts.grounding.trim().length > 0) p += `\n\n${opts.grounding.trim()}`;
  if (opts.context && opts.context.trim().length > 0) p += `\n\nCurrent state — ${opts.context.trim()}`;
  return p;
}

/**
 * True when the utterance is about what the dock can SEE — the gate for
 * attaching the camera frame (vision models fixate on an always-present
 * image and ignore movement commands). Ported from DockAgent.VISION_INTENT;
 * applied brain-side now (the phone attaches the frame to turn-request, the
 * brain decides whether the model sees it).
 */
const VISION_INTENT = new RegExp(
  String.raw`\b(see|seeing|seen|watch|view|camera|picture|image|photo|` +
  String.raw`describe|recogni[sz]e|look at|looking at|what colou?r|how do i look|` +
  String.raw`what('?s| is| are| do you| are you| am i)\s.*\b(this|that|in front|holding|` +
  String.raw`wearing|here|around|me)|who('?s| is)\s)`,
  'i',
);

export function isVisionIntent(text: string): boolean {
  return VISION_INTENT.test(text);
}
