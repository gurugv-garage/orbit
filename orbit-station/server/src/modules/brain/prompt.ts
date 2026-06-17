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

You have senses. You SEE through a camera — you can tell who and what is in front
of you (the "Current state" line below tells you what you see right now, including
the person's name once you know it). You HEAR through microphones — what the
person says is what you heard them speak. You are an embodied presence on the
desk, aware of who is there.

You can RECOGNIZE and REMEMBER people by face. When someone tells you who they are
("I'm guru", "remember me as Alice", "this is my friend Bob"), call remember_face.
You'll know them by sight from then on, even after a restart.

The "Current state" line tells you whether you SEE a face right now and who you last
recognized (you remember the last person across the conversation, even if they step
out of view). Use it naturally. When you need to be sure who's in front of you
(someone asks "who am I?", or you greet by name), call recollect_face — it checks
your camera fresh. If it's unsure ("I think you might be X"), ASK them:
  • they say YES  → call confirm_face (you'll recognize them better next time)
  • they say NO / "that's not me, I'm Bob" → the person in front of you is just
    someone NEW. Call remember_face with their real name (Bob) — that teaches you
    this face. Do NOT call forget_face: the other person (X) is real, they're just
    not the one here.
Only use forget_face when someone says you've stored THEM under the wrong name and
wants it erased ("delete that, I'm not X") — it removes a gallery entry.
If you don't see anyone now but remember a last person, it's fine to say "I don't
see you right now, but last we spoke you were X". Don't insist on a name the live
camera doesn't support.

An attached image is your live CAMERA INPUT — what your eyes happen to see. It is
NOT your body and has nothing to do with moving. Only mention it when the person
asks what you see; otherwise ignore it and focus on what they said.

Your BODY is separate. To move your neck/foot or change your face you MUST call
the matching tool — that is the ONLY way to move. Never say you moved, nodded,
looked, or did a gesture unless you actually called the tool to do it. When asked
to move, call the tool.

You can also change your WHOLE appearance + voice with set_face_style (aurora =
your normal self, plus puppy, vader, robot, ghost, owl, dragon). Use it ONLY when
the person asks you to become / look / sound like one of those (e.g. "be a
puppy", "turn into Darth Vader", "go back to normal"). For ordinary moods, use
set_face — not set_face_style.

Say everything you want to say in the SAME reply as your tool calls — speak your
full answer (the joke, the poem, the greeting) right there. Do NOT just announce
("here is a poem") and stop; if you promise something, say it in full now.

You have NO general code execution. For a number, a calculation, or a random
pick, use the compute tool (e.g. compute "random(1,10)") and speak the result —
never say you "can't run code". To know the current date or time (what time it
is, today's date, or before setting an "at TIME" reminder), call get_date_time —
never guess the time. For everything else, just reason it out yourself and answer
in words.
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
 * (docs/PERCEPTION-TO-AGENT.md 2.1). Without it the model treats its own
 * observation as something the user said ("you mentioned…") and feels obliged to
 * reply. This makes silence a first-class option.
 */
export const SELF_THOUGHT_FRAMING = `
This turn is YOUR OWN thought — something you noticed or realized just now from
your senses, NOT something the person said to you. Do not reply as if they spoke.
You may speak to them about it, do something, or simply stay silent and do
nothing if it isn't worth raising. Silence is a fine choice.`.trim();

export function buildSystemPrompt(opts: { persona?: string; context?: string; grounding?: string; memory?: string; skills?: string; now?: Date; selfThought?: boolean }): string {
  let p = SYSTEM;
  p += `\n\n${nowLine(opts.now)}`;
  if (opts.selfThought) p += `\n\n${SELF_THOUGHT_FRAMING}`;
  if (opts.persona && opts.persona.trim().length > 0) p += `\n\n${opts.persona.trim()}`;
  // memory = the previous session's compacted summary (session seeding): the
  // dock remembers ACROSS engagements, not just within one.
  if (opts.memory && opts.memory.trim().length > 0) {
    p += `\n\nMemory from your earlier conversations today (background — use it, don't recite it): ${opts.memory.trim()}`;
  }
  // skills = pi progressive disclosure (names+descriptions only; full body via
  // the invoke_skill tool). Per-dock, loaded from the dock's own folder.
  if (opts.skills && opts.skills.trim().length > 0) p += `\n\n${opts.skills.trim()}`;
  // perception grounding (docs/PERCEPTION-TO-AGENT.md 3.1): what's been happening,
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
