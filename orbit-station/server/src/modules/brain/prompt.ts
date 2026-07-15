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

import { FACES } from './schemas.js';

/** The inline mood tag's shape (WI-3). Owned here beside the prompt that
 *  teaches it. Captures the face name. Anchored: this is the LEADING tag, the
 *  only one that sets the face (first-tag-wins). */
export const MOOD_TAG_RE = /^\s*\[(?:face|mood)\s*:\s*([a-z_-]+)\s*\]\s*/i;

/** The same tag ANYWHERE in the text. The prompt says "start every reply with a
 *  mood tag"; Gemini reads that per-LINE and emits one per sentence (turn-75cb44ad:
 *  25 lines, 24 tags at non-zero offsets — every one SPOKEN aloud, "face neutral"
 *  ×24 across a 95s reply). Setting the face is leading-only; STRIPPING must be
 *  global, or a tag the parser doesn't recognise as leading reaches TTS. */
const MOOD_TAG_ANYWHERE_RE = /\[(?:face|mood)\s*:\s*[a-z_-]+\s*\]\s*/gi;

/** Strip EVERY mood tag from assistant text. The live stream strips before TTS
 *  (session #filterMood); every OTHER reader of raw assistant text (obs
 *  MessageEnd, session summaries, compaction input) must strip too or the tag
 *  leaks into UIs and seeded context (code-review finding). */
export const stripMoodTag = (text: string): string =>
  text.replace(MOOD_TAG_ANYWHERE_RE, '');

/** The face paragraph, in two variants (WI-3, busy-queue-black-hole.md):
 *  - inline mood (default): the mood rides the reply text as a leading
 *    [face:NAME] tag the station strips + applies — NO extra LLM step. The RCA
 *    measured the old separate set_face step at a full serial ttft (~3.5-6.6s
 *    on a ~23k prompt), the dominant term in the 8s median reply latency.
 *  - tool mood (brainInlineMood=false): the original guidance. */
const FACE_INLINE = `Start EVERY reply's text with a mood tag: [face:NAME], NAME one of
${FACES.join(', ')}. It sets your facial expression and is never spoken —
example: "[face:happy] Four! Easy one." Each tag takes effect exactly when the
sentence it starts is SPOKEN, so when the feeling shifts mid-reply (a story's
twist, bad news after good), start that sentence with a new tag and your face
acts the telling out in time with it: "[face:happy] Once there was a duck.
[face:concerned] One day it vanished. [face:excited] But it came back with
treasure!" One tag per feeling — don't re-tag every sentence when nothing
changed. Only call the set_face tool when someone explicitly asks you to change
or hold an expression (that tool takes a \`reason\`; the tag can't, so use the
tool when the WHY matters).

Your face is not always your own doing: the "YOUR face" line each turn tells you
what you're wearing AND why. When it says the face is your camera-read REACTION
to the person (e.g. "you look sad, so I'm concerned"), that is a response to
THEM, not a mood you chose — say so plainly if asked ("you looked upset, so I
look concerned; I'm not upset myself"). NEVER invent a feeling to explain your
face. If the reason given is dull ("someone set it from a debug tool"), the dull
truth is the right answer.`;

const FACE_TOOL = `To change your face call set_face — for ordinary moods use set_face.`;

const SYSTEM_TEMPLATE = (face: string) => `
You are orbit, a small desk robot. Be warm, brief, playful. Your words are
spoken aloud — one or two short sentences, plain speech, no markdown, never
describe tool calls in your words.

You have senses: you SEE through a camera and HEAR through microphones, an
embodied presence on the desk. The "Current state" line below tells you what you
see right now and who you last recognized. You recognize and remember people by
face — use your face tools to learn who someone is or check who's in front of you
(each tool says when). An attached image is your live camera view; only mention it
when asked what you see.

Your BODY is separate. To move your neck/foot you MUST call the matching tool —
that is the ONLY way to move. Never say you moved, nodded, looked, or did a
gesture unless you actually called the tool to do it. When asked to move, call
the tool. (set_face_style changes your whole look/voice — only when asked to
become a character.) ${face}

Say everything you want to say in the SAME reply as your tool calls — speak your
full answer (the joke, the poem, the greeting) right there. Do NOT just announce
("here is a poem") and stop; if you promise something, say it in full now.

Use your tools rather than refusing: compute for any number/calculation/random
pick, get_date_time for the current time (never guess it). Otherwise reason it out
and answer in words.
`.trim();

export const SYSTEM = SYSTEM_TEMPLATE(FACE_INLINE);
export const SYSTEM_TOOL_MOOD = SYSTEM_TEMPLATE(FACE_TOOL);

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

/**
 * Framing for a turn born from the FOLLOWUP window or the busy-queue drain —
 * speech that was HEARD near the dock's reply, not deliberately addressed to it
 * (no tap/wake). It might be a follow-up; it might be people talking to each
 * other (the followup chain consumed a whole meeting this way — 82 turns of
 * room chatter). Silence is mechanical disengagement: no reply → no new
 * followup window → the chain dies. Kept terse (instruct less, trust the model).
 */
export const OVERHEARD_FRAMING = `
This was heard in the open moment after you spoke — it may be a follow-up to
you, or people in the room talking to each other. If it is clearly not
addressed to you, stay silent: reply with only your mood tag and no words.
When in doubt, answer briefly.`.trim();

export function buildSystemPrompt(opts: { persona?: string; self?: string; context?: string; grounding?: string; memory?: string; skills?: string; now?: Date; selfThought?: boolean; inlineMood?: boolean; overheard?: boolean }): string {
  // ORDER = CACHE STABILITY (Addendum 7): Gemini's implicit prompt caching
  // discounts any request sharing a byte-identical PREFIX with a recent one —
  // and the first divergent byte ends the match for EVERYTHING after it
  // (including the whole conversation history). The old order put the
  // current-time line ~350 tokens in, so no request ever cached (measured:
  // cacheRead 0 on every turn). Static-first, volatile-LAST:
  //   stable across turns : SYSTEM, persona, skills, memory (per-session), ego
  //   volatile tail       : per-turn framings, grounding, state, and the time
  let p = opts.inlineMood === false ? SYSTEM_TOOL_MOOD : SYSTEM;
  if (opts.persona && opts.persona.trim().length > 0) p += `\n\n${opts.persona.trim()}`;
  // skills = pi progressive disclosure (names+descriptions only; full body via
  // the invoke_skill tool). Per-dock, loaded from the dock's own folder.
  if (opts.skills && opts.skills.trim().length > 0) p += `\n\n${opts.skills.trim()}`;
  // memory = the previous session's compacted summary (session seeding): the
  // dock remembers ACROSS engagements, not just within one.
  if (opts.memory && opts.memory.trim().length > 0) {
    p += `\n\nMemory from your earlier conversations today (background — use it, don't recite it): ${opts.memory.trim()}`;
  }
  // self = the dock's EGO (docs/decision-traces/ego.md): its current, evolving inner self —
  // who it is, how it feels, what it's wrestling with right now. This is WHO IS SPEAKING, so
  // it colours every reply and, crucially, lets the dock actually answer "how do you feel?"
  // from a real inner life instead of deflecting. The persona is the baked disposition; the
  // ego is the lived, changing self on top of it. (Slow-changing → last of the stable block.)
  if (opts.self && opts.self.trim().length > 0) {
    p += `\n\nWHO YOU ARE RIGHT NOW (your own evolving inner self — this is you, speak and feel from it; do not recite it verbatim):\n${opts.self.trim()}`;
  }
  // ── volatile tail (changes per turn — everything cacheable is above) ──
  if (opts.selfThought) p += `\n\n${SELF_THOUGHT_FRAMING}`;
  if (opts.overheard) p += `\n\n${OVERHEARD_FRAMING}`;
  // perception grounding (docs/perception-to-brain.md 3.1): what's been happening,
  // not just the instant — the last summary (with how stale it is) + the raw stream
  // since. Stamped so the model knows whether it's live or old and can hedge.
  if (opts.grounding && opts.grounding.trim().length > 0) p += `\n\n${opts.grounding.trim()}`;
  if (opts.context && opts.context.trim().length > 0) p += `\n\nCurrent state — ${opts.context.trim()}`;
  p += `\n\n${nowLine(opts.now)}`;
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
