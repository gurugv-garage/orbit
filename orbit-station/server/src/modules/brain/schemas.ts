/**
 * The dock's tool **schemas + catalogs** — the JSON the model sees and the
 * valid value sets — with NO execution. Ported from the app's
 * `DockToolSchemas.kt` (deleted at cutover); THIS is now the single copy of
 * the model-facing tool surface. Execution lives in tools.ts.
 *
 * Schemas are plain JSON Schema objects (what every provider serializes);
 * pi-agent-core's `Tool.parameters` is TypeBox, which is JSON Schema at
 * runtime — these cast cleanly.
 */

export const FACES = [
  'neutral', 'happy', 'curious', 'concerned', 'surprised', 'sad', 'excited', 'angry', 'love',
] as const;

/**
 * The dock's selectable face appearances ("skins"). Each is a distinct look AND
 * voice on the phone. Keep in sync with FaceRegistry on the dock app
 * (node-dock/.../ui/face/FaceRegistry.kt) and the `faceStyle` config enum.
 */
export const FACE_STYLES = [
  'aurora', 'puppy', 'vader', 'robot', 'ghost', 'owl', 'dragon',
] as const;

/**
 * The degree↔µs scale is FIXED and universal for every part:
 *   -90° = 500µs, 0° = 1500µs, +90° = 2500µs  (1° ≈ 11.11µs).
 * A given degree is the same physical servo angle everywhere.
 */
const FULL_SWING_DEG = 90;

/**
 * Per-part LIMIT (min, max) on how far the LLM may command, in degrees from
 * neutral. Restricts (and clamps) — never rescales. Both joints are MG90S;
 * the FOOT is a direct 1:1 swivel → full ±90°; the NECK runs through a
 * sector-gear pair, mechanically limited AND ASYMMETRIC (positive = head
 * down). Calibrated on hardware to −60° (full up) … +35° (full down).
 * Mirror: orbit-station/web/src/lib/bodyAngles.ts.
 */
export const DEGREE_LIMITS: Record<string, [number, number]> = {
  neck: [-60, 35],
  foot: [-90, 90],
};

/**
 * Convert an absolute angle for a part to a servo pulse width (µs): clamp to
 * the part's limits, then map on the universal ±90° = 500–2500µs scale.
 * (Ported from DockToolSchemas.degreesToUs — the conversion lives at the
 * station now, next to the motion executor that uses it.)
 */
export function degreesToUs(part: string, degrees: number): number {
  const [lo, hi] = DEGREE_LIMITS[part] ?? [-FULL_SWING_DEG, FULL_SWING_DEG];
  const clamped = Math.min(Math.max(degrees, lo!), hi!);
  const us = Math.trunc(1500 + (clamped / FULL_SWING_DEG) * 1000);
  return Math.min(Math.max(us, 500), 2500);
}

// ── JSON Schemas (verbatim port — the model-facing surface) ────────────────

export const setFaceSchema = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description: 'the mood to show',
      enum: [...FACES],
    },
  },
  required: ['expression'],
} as const;

export const setFaceStyleSchema = {
  type: 'object',
  properties: {
    style: {
      type: 'string',
      description: 'which face appearance + voice to wear',
      enum: [...FACE_STYLES],
    },
  },
  required: ['style'],
} as const;

/**
 * The ONE movement tool: an ordered sequence of steps the body performs.
 * A step moves one or more joints AT THE SAME TIME over `duration_ms`, then
 * pauses `wait_ms` before the next step.
 */
export const moveSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description:
        'Ordered steps, performed one after another. Each step moves its joint(s) ' +
        "SIMULTANEOUSLY. For 'neck and foot at the same time', list both in one step's " +
        "`parts`. For 'do X then Y', use two steps.",
      items: {
        type: 'object',
        properties: {
          part: {
            type: 'string',
            description: 'which joint (single-joint step). Use `parts` instead to move several at once.',
            enum: ['neck', 'foot'],
          },
          degrees: {
            type: 'number',
            description:
              'Absolute target angle in degrees. 0 = neutral. ' +
              'neck: -60 = fully up … 0 = level … +35 = fully down (range -60°…+35°, tilts up more than down). ' +
              'foot: -90 = fully left … 0 = forward … +90 = fully right (range ±90°). ' +
              "'a little' ≈ a third of range, 'all the way' ≈ the limit. Out-of-range clamps.",
          },
          parts: {
            type: 'array',
            description: 'Several joints to move TOGETHER in this step (simultaneous). Use instead of part/degrees.',
            items: {
              type: 'object',
              properties: {
                part: { type: 'string', enum: ['neck', 'foot'] },
                degrees: { type: 'number', description: 'absolute angle for this joint' },
              },
              required: ['part', 'degrees'],
            },
          },
          duration_ms: {
            type: 'integer',
            description:
              "Time for this step's joint(s) to reach target. 0 = snap, ~250 = quick, " +
              '~600 = normal, ~1500 = slow. Range 0–5000. Default ~400.',
            minimum: 0,
            maximum: 5000,
          },
          wait_ms: {
            type: 'integer',
            description:
              'Pause AFTER this step before the next, in ms (0–5000). A step may be ' +
              'wait-only ({wait_ms: 2000}, no part) — a pure pause between moves.',
            minimum: 0,
            maximum: 5000,
          },
        },
        // a step needs EITHER part+degrees OR parts; validated in code.
      },
    },
  },
  required: ['steps'],
} as const;

export const computeSchema = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description: 'an arithmetic/comparison expression, e.g. "3+4*2", "random(1,10)", "random(1,10) > 5"',
    },
  },
  required: ['expression'],
} as const;

export const getDateTimeSchema = {
  type: 'object',
  properties: {},
} as const;

export const forceGetCurrentSchema = {
  type: 'object',
  properties: {},
} as const;

export const rememberFaceSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'the person\'s name, e.g. "guru"' },
  },
  required: ['name'],
} as const;

export const recollectFaceSchema = {
  type: 'object',
  properties: {},
} as const;

export const confirmFaceSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'the name the person just confirmed they are' },
  },
  required: ['name'],
} as const;

export const forgetFaceSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'the name whose stored face should be erased' },
  },
  required: ['name'],
} as const;

export const takePhotoSchema = {
  type: 'object',
  properties: {
    caption: { type: 'string', description: 'an optional caption to show / post with the photo' },
    slackChannel: { type: 'string', description: 'a Slack channel id (Cxxxx) or #name to send the photo to; omit to just show it on the dock (or use the default channel)' },
  },
} as const;

export const recordVideoSchema = {
  type: 'object',
  properties: {
    seconds: { type: 'number', description: 'how many seconds to record (1–30; default 5)' },
    caption: { type: 'string', description: 'an optional caption to post with the clip' },
    slackChannel: { type: 'string', description: 'a Slack channel id (Cxxxx) or #name to send the clip to (or use the default channel)' },
  },
} as const;

export const sendToSlackSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'the message text (Slack mrkdwn: *bold*, _italic_, `code`, <url|label>). To @mention a person, either include their @handle as <@handle> OR list them in `mention` and reference them naturally.' },
    channel: { type: 'string', description: 'a Slack channel id (Cxxxx) or #name; omit to use the default channel' },
    mention: { type: 'array', items: { type: 'string' }, description: 'optional names/handles/emails to @mention; each is resolved to a Slack mention and prepended to the message' },
  },
  required: ['text'],
} as const;

export const dmSlackUserSchema = {
  type: 'object',
  properties: {
    user: { type: 'string', description: 'who to DM — a person\'s name, @handle, or email (resolved to a Slack user)' },
    text: { type: 'string', description: 'the direct-message text (Slack mrkdwn supported)' },
  },
  required: ['user', 'text'],
} as const;

export const listSlackMembersSchema = {
  type: 'object',
  properties: {
    channel: { type: 'string', description: 'a Slack channel id (Cxxxx) or #name; omit to use the default channel' },
  },
} as const;

export const sendToWhatsAppSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'the message text. WhatsApp supports *bold*, _italic_, ~strikethrough~, and ```monospace```.' },
    to: { type: 'string', description: 'a single recipient phone number in E.164 (e.g. +15551234567); omit to use the default recipient' },
    recipients: { type: 'array', items: { type: 'string' }, description: 'send the SAME message to several people — each an E.164 number (each gets their own 1:1 chat; WhatsApp has no group send). Use this OR `to`, not both.' },
  },
  required: ['text'],
} as const;

export const recordFeedbackSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'a SHORT label for the feedback (e.g. "head did not move", "misheard me", "great answer"). One line.' },
    detail: { type: 'string', description: 'optional longer explanation — what the user expected vs. what happened, in their words.' },
  },
  required: ['reason'],
} as const;

export const inspectObservabilitySchema = {
  type: 'object',
  properties: {
    aspect: {
      type: 'string',
      enum: ['version', 'health', 'session', 'all'],
      description: "what to look up: 'version' = my current build/version (git sha, app/firmware, models); 'health' = this session's latency/error metrics; 'session' = the turn-by-turn timings of the current session; 'all' = everything.",
    },
  },
  required: ['aspect'],
} as const;

export const RECORD_FEEDBACK_DESC =
  "Record the user's feedback about how I'm doing for later review. Use when the user is clearly happy or unhappy, " +
  'points out something I got wrong (misheard, didn\'t move, wrong answer, too slow), or explicitly says "give feedback". ' +
  'This snapshots the whole session — my traces, timings, perception, version — and saves it with their words to the ' +
  'feedback folder for later analysis. If their reason is vague, ask ONE quick clarifying question first (what did they ' +
  'expect?), then record. Confirm briefly that it was saved to the feedback folder for review whenever they want.';

export const INSPECT_OBSERVABILITY_DESC =
  'Look up structured facts about MYSELF and this session — my current software version/build (git, app, firmware), ' +
  'the active models, and this session\'s health (latencies, errors, per-turn timings). Use when the user asks "what ' +
  'version are you", "how fast were you", "did you have errors", or when helping them give precise feedback (so you can ' +
  'tell them what actually happened). Returns the data for YOU to explain conversationally — do not dump the raw JSON at them.';

export const researchRecentSchema = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'what to research — a person, product, project, brand, or event (e.g. "Claude Code", "Nvidia earnings", "Peter Steinberger")' },
    context: { type: 'string', description: 'optional disambiguating anchor for collision-prone names — the entity\'s company, role, or domain (e.g. "Digg founder" for Kevin Rose, "screen recording" for Tella). Omit when the name is globally unambiguous.' },
    depth: { type: 'string', enum: ['quick', 'deep'], description: 'quick = faster, fewer items (default; good for a spoken reply); deep = higher-recall, slower (up to ~3 min)' },
    days: { type: 'number', description: 'look back this many days instead of the default 30' },
  },
  required: ['topic'],
} as const;

// Descriptions live next to the schemas so the model-facing surface is one place.
export const RESEARCH_RECENT_DESC =
  'Research what people have been saying about a topic RECENTLY (the last ~30 days) across Reddit, ' +
  'Hacker News, YouTube, GitHub, and prediction markets, ranked by real engagement (upvotes/views/odds). ' +
  'Use for current-events / "what\'s the latest on…" / "what are people saying about…" / "how was X received" ' +
  'questions where your own knowledge may be stale — it pulls fresh community discussion you don\'t have. ' +
  'For a collision-prone name, pass a `context` anchor (the person\'s company/role) so it stays on-topic. ' +
  'Returns a synthesized brief with citations; weave the findings into your answer naturally — do NOT read ' +
  'the raw list back. Takes ~30s (quick) so tell the user you\'re looking it up.';
export const TAKE_PHOTO_DESC =
  'Produce a PHOTO (an image artifact) with your camera right now and share it. ' +
  'Use when the user wants the PICTURE itself — "take/snap a photo", "send a pic", "show me on Slack". ' +
  'With a Slack channel (or a configured default) it posts the photo there; otherwise it shows it on the dock. ' +
  'This is immediate — it returns the moment the photo is captured. ' +
  'NOT for answering "what do you see?" — to DESCRIBE the live moment in words, use force_get_current instead.';
export const RECORD_VIDEO_DESC =
  'Record a SHORT video clip from your camera for a few seconds (1–30s, default 5). ' +
  'Use when the user asks you to record / take a video or capture a clip of what you see. ' +
  "This KICKS OFF the recording and returns immediately — you don't wait for it. When the clip is ready " +
  "it's sent automatically (to Slack if a channel/default is set, else shown on the dock), so just confirm " +
  "you've started recording and that you'll share it when it's done.";
export const SEND_TO_SLACK_DESC =
  'Send a message to a Slack CHANNEL. Use when the user asks you to post / send / message something to Slack. ' +
  'Supports Slack formatting (mrkdwn): *bold*, _italic_, `code`, <https://url|link text>, and emoji. ' +
  'Give the channel id or #name, or omit it to use the configured default channel. ' +
  'To @mention people, pass their names/handles in `mention` (resolved automatically). ' +
  'For a PRIVATE message to one person, use dm_slack_user instead.';
export const DM_SLACK_USER_DESC =
  'Send a DIRECT (private) message to one person on Slack. Use when the user asks you to DM / privately ' +
  'message someone. Identify them by name, @handle, or email — it resolves to the right Slack user. ' +
  'For a public channel post, use send_to_slack instead.';
export const LIST_SLACK_MEMBERS_DESC =
  'List the people in a Slack channel (their names). Use when asked who is in a channel, or before ' +
  'mentioning/DMing someone to find the right person. Defaults to the configured channel if none is given.';
export const SEND_TO_WHATSAPP_DESC =
  'Send a WhatsApp message to one or more people. Use when the user asks you to message / text / WhatsApp ' +
  'someone. Give one recipient in `to` (E.164, +15551234567), or several in `recipients` to send the SAME ' +
  'message to each — every person gets their own 1:1 chat (WhatsApp has no group send, so "tell the group" ' +
  'means listing the people). Omit both to use the configured default recipient. ' +
  'WhatsApp formatting works: *bold*, _italic_, ~strikethrough~, ```monospace```. ' +
  'Note: a reply is free within 24h of their last message; an unprompted message outside that window may ' +
  'be rejected (needs a pre-approved template) — if so, say the message could not be delivered.';
export const SET_FACE_DESC =
  "Set the dock's facial expression to match the mood of what you're saying. " +
  'The body also acts out the mood automatically — a sleepy face droops the head, excited does a happy ' +
  "wiggle, love a dreamy tilt, surprised a snap-back, etc. — so you usually DON'T need a separate `move` " +
  'for emotion; use `move` only for deliberate, literal motions (nod yes, look left, point).';
export const SET_FACE_STYLE_DESC =
  "Change the dock's WHOLE face appearance and voice — its persona skin, not just its mood. " +
  'Use ONLY when the user asks you to become / look like / sound like something (e.g. "be a puppy", ' +
  '"turn into Darth Vader", "go back to normal"). aurora = the default friendly face; puppy = a cute dog; ' +
  'vader = Darth Vader (low, slow voice); robot, ghost, owl, dragon. This persists until changed. ' +
  'For ordinary moods within the current face, use `set_face`, not this.';
export const MOVE_DESC =
  'Move the body. Give an ordered list of steps; each step moves its joint(s) to an ' +
  'absolute angle in DEGREES over a duration, with an optional pause after. ' +
  'The steps list can be ANY LENGTH — chain as many as the motion needs. ' +
  'neck nods up/down (-60°…+35°, 0=level, negative=up — tilts up more than down). foot swivels left/right (±90°, 0=forward, negative=left). ' +
  "SAME TIME (neck AND foot together): put both in ONE step's `parts`, e.g. " +
  '{parts:[{part:neck,degrees:-20},{part:foot,degrees:30}]}. ONE AFTER ANOTHER: use separate steps ' +
  '(e.g. nod = neck +25 then 0; look around = foot -60 wait, foot +60 wait, foot 0). ' +
  "REPEATING is just repeating the steps: 'nod 5 times' = the nod's steps listed 5 times in a row. " +
  'There is NO limit on how many times you repeat — just build the full sequence. ' +
  'You choose the angle, speed (duration_ms) and beats (wait_ms).';
export const COMPUTE_DESC =
  'Evaluate a SAFE arithmetic or random-number expression and get the result back ' +
  '(e.g. math, or "random(1,10)", or "random(1,10) > 5"). Use this whenever you\'d otherwise want to ' +
  '"run code" for a number or a calculation — you have NO general code execution, only this.';
export const GET_DATE_TIME_DESC =
  'Get the current date and time (local timezone of where you run). Call this whenever you ' +
  'need to know "now" — what time it is, today\'s date/day of week, or to reason about an ' +
  '"at TIME" / "in N minutes" request before scheduling a reminder. Takes no arguments.';
export const FORCE_GET_CURRENT_DESC =
  'Look and listen RIGHT NOW and get a fresh read of what is happening around you — ' +
  'the live moment, not the background sense you already have. Use this when the person ' +
  'pushes for now-ness ("what am I holding right now?", "what do you see this instant?", ' +
  '"look again"), or when your background perception feels stale and you need to be current ' +
  'before answering. It captures a fresh camera + audio snapshot and summarizes it. ' +
  'Deliberate and a little slow (a real capture) — do not call it every turn; your ongoing ' +
  'perception already rides along. Takes no arguments.';
export const REMEMBER_FACE_DESC =
  'Remember the person you can currently see in your camera, by name. ' +
  'Call this when someone tells you who they are ("I\'m guru", "remember me as Alice", "this is my friend Bob"). ' +
  "You'll recognize them by face from now on, even after a restart. Overwrites if the name already exists.";
export const RECOLLECT_FACE_DESC =
  "Find out who is in front of you right now — returns their name if you've met them, " +
  'or that you don\'t recognize them, or that no one is there. Use it when asked "do you know me?" / "who am I?". ' +
  'If it comes back unsure ("I think you might be X — is that right?"), ASK them: if YES call confirm_face; if NO ' +
  'they are simply someone new — ask their name and call remember_face (do NOT forget_face).';
export const CONFIRM_FACE_DESC =
  'Confirm a tentative face guess after the person says yes. When recollect_face said ' +
  '"I think you might be X" and they confirm they ARE X, call confirm_face with that name — it makes your ' +
  'recognition of them stronger for next time. Only call after they actually confirm.';
export const FORGET_FACE_DESC =
  "Erase a face you've stored under a wrong name — ONLY when someone explicitly asks you " +
  'to delete a stored identity ("delete that", "don\'t remember me as X"). Do NOT call this just because a guess ' +
  'was wrong: if you mis-guessed and the person is actually someone new, use remember_face with their real name instead.';

// ── memory tools (docs/perception-to-brain.md 3.2 + Decision 4) ──────────────
export const MEMORY_TYPES = ['person', 'summary', 'event', 'preference', 'fact', 'place'] as const;

export const recallMemorySchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'a natural-language question to search your memories semantically, e.g. "did we talk about my flight?"' },
    subject: { type: 'string', description: 'who/what the memory is about, e.g. "guru" or "kitchen" (exact subject filter)' },
    type: { type: 'string', enum: MEMORY_TYPES, description: 'narrow to a kind of memory' },
  },
} as const;

export const listRecentSchema = {
  type: 'object',
  properties: { limit: { type: 'number', description: 'how many recent memories (default 10)' } },
} as const;

export const inspectMemorySchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'the memory id (from a recall result)' } },
  required: ['id'],
} as const;

export const rememberSchema = {
  type: 'object',
  properties: {
    claim: { type: 'string', description: 'the fact to remember, in your own words, e.g. "prefers tea over coffee"' },
    subject: { type: 'string', description: 'who/what it is about, e.g. "guru"' },
    type: { type: 'string', enum: MEMORY_TYPES, description: 'the kind of memory (default: fact)' },
  },
  required: ['claim'],
} as const;

export const updateMemorySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'the memory id to revise (from a recall result)' },
    claim: { type: 'string', description: 'the corrected fact' },
  },
  required: ['id', 'claim'],
} as const;

export const forgetMemorySchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'the memory id to forget (from a recall result)' } },
  required: ['id'],
} as const;

export const RECALL_MEMORY_DESC =
  'Search your own memory — what you know about the people, places, preferences, and ' +
  'things that have happened around you. Use a natural-language `query` to find by meaning ' +
  '("what do I know about Guru", "did we talk about lunch"), and/or `subject`/`type` to ' +
  'narrow it. Returns matching memories with their confidence and when you learned them. ' +
  'Call this when the person refers to something past, asks what you know/remember, or you ' +
  'need context you do not already have in front of you.';
export const LIST_SUBJECTS_DESC =
  'List who and what you have memories about (the subjects) — a quick way to orient before ' +
  'a targeted recall. Takes no arguments.';
export const LIST_RECENT_DESC =
  'List your most recent memories — what you have learned or noted lately. Use it to get ' +
  'your bearings or when asked "what do you remember recently?".';
export const INSPECT_MEMORY_DESC =
  'Look into WHY you believe a memory — what it was derived from (which observations / other ' +
  'memories), when, and how confident you are. Use this when someone challenges or questions ' +
  'a memory ("are you sure?", "that\'s wrong") so you can either defend it with what you saw, ' +
  'or recognize it was a thin inference and correct it with update_memory.';
export const REMEMBER_DESC =
  'Remember a new fact you learned in conversation — a preference, a detail about someone, ' +
  'something to keep in mind ("Guru prefers tea", "the standup is at 10"). Give the claim in ' +
  'your own words, who/what it is about (subject), and the kind. For remembering a PERSON BY ' +
  'FACE, use remember_face instead — this is for facts, not faces.';
export const UPDATE_MEMORY_DESC =
  'Correct a memory the person says is wrong, or that you have learned has changed. Keeps the ' +
  'old version in your history (you can still say what you used to believe) but makes the new ' +
  'claim your current belief. Use after inspect_memory when you decide a memory needs revising.';
export const FORGET_MEMORY_DESC =
  'Forget a memory — when it is wrong, no longer true, or the person asks you to drop it. ' +
  'It stops surfacing in recall (kept in history, not surfaced). For forgetting a stored FACE, ' +
  'use forget_face instead.';

/**
 * One move step, as the model emits it (single-joint or multi-joint form).
 * Shared vocabulary with the motion executor and the faceGestures config.
 */
export interface MoveStep {
  part?: string;
  degrees?: number;
  parts?: Array<{ part: string; degrees: number }>;
  duration_ms?: number;
  wait_ms?: number;
}

/** Normalize a step to its joint list ([] for a pure wait). */
export function stepJoints(step: MoveStep): Array<{ part: string; degrees: number }> {
  if (step.parts && step.parts.length > 0) return step.parts;
  if (step.part != null && step.degrees != null) return [{ part: step.part, degrees: step.degrees }];
  return [];
}
