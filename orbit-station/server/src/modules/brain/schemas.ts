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
    // The model is the ONE setter that knows its own reason, and that reason used
    // to be thrown away at the exact moment it existed — so asked "why do you look
    // sad?" a turn later, the dock invented an answer. Captured here, it comes back
    // in the next turn's state line and is answered from the record.
    reason: {
      type: 'string',
      description:
        'WHY you are making this face, in one short clause, addressed to the person '
        + '(e.g. "you said the deploy failed"). You will be shown this next turn if '
        + 'they ask why you look that way — so make it true, not poetic.',
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

export const setZoomSchema = {
  type: 'object',
  properties: {
    ratio: {
      type: 'number',
      description: 'absolute zoom factor; 1.0 = no zoom (full frame). Clamped to what the camera supports.',
    },
  },
  required: ['ratio'],
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
              'Angle in degrees. ABSOLUTE by default (0 = neutral); a DELTA if `relative` is true. ' +
              'neck: -60 = fully up … 0 = level … +35 = fully down (range -60°…+35°, tilts up more than down). ' +
              'foot: -90 = fully right … 0 = forward … +90 = fully left (range ±90°). ' +
              "'a little' ≈ a third of range, 'all the way' ≈ the limit. Out-of-range clamps.",
          },
          relative: {
            type: 'boolean',
            description:
              'When true, `degrees` is a DELTA from where the joint is NOW, not an absolute angle. ' +
              'USE THIS for "turn more/further", "a bit more right", "turn right AGAIN", "keep going" — ' +
              'e.g. one more nudge right = {part:foot, degrees:-30, relative:true}. It clamps at the limit, ' +
              'so repeated relative turns keep moving until the joint can\'t go further. Prefer relative for ' +
              'any instruction that continues or extends the current pose; use absolute to go to a specific place.',
          },
          parts: {
            type: 'array',
            description: 'Several joints to move TOGETHER in this step (simultaneous). Use instead of part/degrees.',
            items: {
              type: 'object',
              properties: {
                part: { type: 'string', enum: ['neck', 'foot'] },
                degrees: { type: 'number', description: 'angle for this joint (absolute, or a delta if relative:true)' },
                relative: { type: 'boolean', description: 'degrees is a delta from the current angle (see the step-level `relative`)' },
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
    timing: {
      type: 'string',
      enum: ['now', 'after_speech', 'at_tag'],
      description:
        'WHEN the motion starts, relative to your spoken words. Omit for the natural default: ' +
        'if your reply text comes BEFORE this call, the body waits until those words are spoken ' +
        '(announce → then act); if you call with no text first, it moves immediately. ' +
        '"now" = move WHILE talking (gesturing along with a story). ' +
        '"after_speech" = explicitly wait for everything you said to finish. ' +
        '"at_tag" = start exactly where you placed a [move] tag in your text (see the tool description).',
    },
  },
  required: ['steps'],
} as const;

/** The move tool's timing modes (motion-speech-timing). 'auto' is the unset
 *  default — part order decides (text first → after those words). */
export type MoveTiming = 'now' | 'after_speech' | 'at_tag' | 'auto';

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
    from_shot: { type: 'string', description: 'OPTIONAL: send a specific saved view instead of a fresh capture. Pass the found-view handle from a recent visual_search result — this sends the EXACT frame where the target was found, so "find X then send a photo of it" shows what you found, not a new (possibly changed) view.' },
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

export const capturePhotoSchema = {
  type: 'object',
  properties: {
    secondsAgo: { type: 'number', description: 'how many seconds back to grab the frame from (0 = right now; up to ~60s of recent history is kept). Use this to capture the MOMENT you just noticed something, not the live frame after it passed.' },
    caption: { type: 'string', description: 'an optional caption to show / post with the photo' },
    slackChannel: { type: 'string', description: 'a Slack channel id (Cxxxx) or #name to send the photo to; omit to just show it on the dock (or use the default channel)' },
  },
} as const;

export const visualQuerySchema = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'what you want to know about the scene, e.g. "what colour is the mug?" or "is the door open?"' },
    secondsAgo: { type: 'number', description: 'how many seconds back the moment you are asking about was (0 = right now; up to ~60s kept). e.g. if you just heard a noise, ask about the frame from a second or two ago, not the live one.' },
  },
  required: ['question'],
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

export const END_SESSION_DESC =
  'End the current conversation session and start fresh. Use ONLY when the person '
  + 'explicitly asks — "start a new session", "kill this session", "start over", '
  + '"reset" / "forget this conversation". The close is DEFERRED: it happens right '
  + 'after you finish speaking this turn, so say a brief sign-off (e.g. "okay, fresh '
  + 'start!"). A short memory note of this conversation carries into the next '
  + 'session automatically.';

export const endSessionSchema = {
  type: 'object',
  properties: {},
} as const;

export const KEEP_QUIET_DESC =
  'Go QUIET (🤐): stop speaking for a while. Use when the person clearly wants you '
  + 'to be silent — "be quiet", "stop talking for a bit", "shush", "let me focus", '
  + '"don\'t talk during the meeting". While quiet you keep watching and listening '
  + 'and your body still idles, but you do NOT reply to anything and you make no '
  + 'unprompted remarks. Say a brief acknowledgement THIS turn (e.g. "okay, going '
  + 'quiet 🤐") — quiet starts right after. Give `minutes` if they named a duration '
  + '("for ten minutes", "until the call\'s over" ≈ your best guess); OMIT it if they '
  + 'want you quiet with no set end (it stays until they tell you to talk again or '
  + 'someone flips the toggle). You cannot un-quiet yourself — the person does.';

export const keepQuietSchema = {
  type: 'object',
  properties: {
    minutes: {
      type: 'number',
      description: 'how many minutes to stay quiet before speaking again on your own. Omit for indefinite (until the person asks you to talk again). Use their stated duration, or a sensible estimate when they gave a vaguer bound.',
    },
  },
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

export const explainTurnSchema = {
  type: 'object',
  properties: {
    back: {
      type: 'number',
      description: 'how many completed turns to look back (1 = the turn right before this one, the default; 2 = the one before that). Ignored when `match` is given.',
    },
    match: {
      type: 'string',
      description: 'optional: find the most recent completed turn whose trigger text contains this (case-insensitive), instead of counting back. Use when the user refers to a specific thing you said ("why did you mention the weather").',
    },
  },
  required: [],
} as const;

export const EXPLAIN_TURN_DESC =
  'Explain WHY I said or did something, from my own recorded trace — use for "why did you say/do that", ' +
  '"why did you answer", "why so slow", "what did that cost". Returns ONE past turn in full: what triggered it ' +
  '(and whether speech was addressed to me), each thinking step, every tool I called with its inputs and results, ' +
  'timings, errors, and cost. Prefer this over reading files or curling endpoints — it is one fast call. Default ' +
  'is the turn right before this one (back:1). Read the trace, THEN explain in your own words; never guess about ' +
  'your past behaviour when this tool can tell you.';

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

export const visualSearchSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'WHO or WHAT to find, in natural language — a known person\'s name ("Guru"), "anyone", ' +
        'or any object/description ("the TV", "white cup", "something red on the table").',
    },
    budget_s: {
      type: 'number',
      description: 'How long to keep looking, seconds (default 30, max 45). Map it from the user\'s intent: a quick glance ≈ 10, "search properly / look everywhere" ≈ 45.',
    },
    tilt: {
      type: 'string',
      enum: ['level', 'down', 'up', 'all'],
      description: 'Where to look vertically: "level" eye-height only, "down" adds desks/floor (default), "up" adds shelves/ceiling, "all" covers everything (slowest).',
    },
    resume: {
      type: 'boolean',
      description: 'Continue the RECENT search instead of restarting — use when the user says "keep looking", "look more", or steers you ("try the left side") right after a search.',
    },
    exclude_current: {
      type: 'boolean',
      description: 'The user rejected who/what you found ("not that one", "no, the other one") — rule it out and continue to the next candidate. Implies resume.',
    },
  },
  required: ['query'],
} as const;

export const webSearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'what to find out, as a full question or search phrase (e.g. "when does Outer Banks season 5 release", "current gold price in India")' },
  },
  required: ['query'],
} as const;

// Descriptions live next to the schemas so the model-facing surface is one place.
export const VISUAL_SEARCH_DESC =
  'Physically LOOK AROUND the room to find a PERSON or an OBJECT: sweeps the body through a grid of ' +
  'camera poses, checks each view, and ends FACING the target. Use for "find me", "find Guru", ' +
  '"is anyone here", "find the TV", "where is the white cup", "look for something red". Pass the ' +
  'user\'s target in `query` as natural language — people you know are matched by face; anything ' +
  'else is judged visually. This does the whole search itself — do NOT hand-roll move+recollect_face loops. ' +
  'It runs for several seconds; announce first ("Let me have a look around!") so the words play while you search. ' +
  'It remembers its recent coverage: if the user says "keep looking" / "look more" / steers you ' +
  '("check the left side"), call again with resume:true; if they reject the find ("not that one"), ' +
  'call again with exclude_current:true. The result reports where it looked — relay honestly, never ' +
  'claim you searched more than it says. If it cannot see the person but their VOICE was matched, say that.';
export const WEB_SEARCH_DESC =
  'Search the web and get back a grounded answer with its sources. Use for any "look it up" ask — ' +
  'current facts, dates, prices, news, release dates, anything your own knowledge may be stale or missing on. ' +
  'This is the ONLY way you search the web: do NOT drive google/duckduckgo/bing through the browse skill ' +
  '(search engines block headless browsers). Use the browse skill only to OPEN a specific page/URL you ' +
  'already know. Takes a few seconds; answer from the result and cite a source naturally when it matters. ' +
  'For "what are people saying about X" community-buzz questions, prefer research_recent instead.';
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
export const CAPTURE_PHOTO_DESC =
  'Produce a PHOTO from a MOMENT — like take_photo, but you can look BACK a few seconds (secondsAgo). ' +
  'The station keeps ~60s of recent camera frames, so if you just noticed something (a gesture, an ' +
  'expression, something held up) you can grab the frame from when it happened instead of the live ' +
  'frame after the moment passed. secondsAgo=0 is the same as take_photo (right now). With a Slack ' +
  'channel (or default) it posts there, otherwise it shows on the dock. ' +
  'NOT for answering "what did I see?" in words — use visual_query for that.';
export const VISUAL_QUERY_DESC =
  'ASK a question about what the camera saw — at a chosen MOMENT. The station keeps ~60s of recent ' +
  'frames, so secondsAgo lets you ask about the instant a thing happened ("you just heard a clink — ' +
  'what was it?") rather than racing the live stream. Answers in words from the single frame at that ' +
  'moment (secondsAgo=0 = now). Use for "what colour / how many / is it open" about a specific instant. ' +
  'For a continuous "look around and FIND X" search across the room, use visual_search instead; for a ' +
  'plain word-description of the live scene, force_get_current.';
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
  'for emotion; use `move` only for deliberate, literal motions (nod yes, look left, point). ' +
  'ALWAYS pass `reason` — you are the only one who knows why you chose this face, and you will be ' +
  'shown it next turn if they ask why you look that way.';
export const SET_FACE_STYLE_DESC =
  "Change the dock's WHOLE face appearance and voice — its persona skin, not just its mood. " +
  'Use ONLY when the user asks you to become / look like / sound like something (e.g. "be a puppy", ' +
  '"turn into Darth Vader", "go back to normal"). aurora = the default friendly face; puppy = a cute dog; ' +
  'vader = Darth Vader (low, slow voice); robot, ghost, owl, dragon. This persists until changed. ' +
  'For ordinary moods within the current face, use `set_face`, not this.';
export const SET_ZOOM_DESC =
  "Zoom the dock's camera to look closer — use it to read something small the user holds up, " +
  'or to inspect the user / an object in more detail. `ratio` is an absolute factor: 1.0 = normal ' +
  '(no zoom, full frame), 2.0 = twice as close, etc. Set 1.0 to zoom back out to normal. The value ' +
  'is clamped to the range this camera supports; the result tells you the actual ratio applied.';
export const MOVE_DESC =
  'Move the body. Give an ordered list of steps; each step moves its joint(s) to an ' +
  'absolute angle in DEGREES over a duration, with an optional pause after. ' +
  'The steps list can be ANY LENGTH — chain as many as the motion needs. ' +
  'neck nods up/down (-60°…+35°, 0=level, negative=up — tilts up more than down). foot swivels left/right (±90°, 0=forward, negative=right, positive=left). ' +
  "SAME TIME (neck AND foot together): put both in ONE step's `parts`, e.g. " +
  '{parts:[{part:neck,degrees:-20},{part:foot,degrees:30}]}. ONE AFTER ANOTHER: use separate steps ' +
  '(e.g. nod = neck +25 then 0; look around = foot -60 wait, foot +60 wait, foot 0). ' +
  "REPEATING is just repeating the steps: 'nod 5 times' = the nod's steps listed 5 times in a row. " +
  'There is NO limit on how many times you repeat — just build the full sequence. ' +
  'RELATIVE moves: for "turn more/further", "a bit more right", "turn right AGAIN", "keep going" set ' +
  'relative:true and give a DELTA (e.g. one more nudge right = {part:foot, degrees:-30, relative:true}); it ' +
  'moves from wherever the joint is now and clamps at the limit — so you never need to know or track the ' +
  'current angle, and repeated turns keep going until they can\'t. Use absolute degrees to go to a SPECIFIC pose. ' +
  'The "Current state" line reports the pose you are in now (facing + angles) — read it before an absolute move. ' +
  'You choose the angle, speed (duration_ms) and beats (wait_ms). ' +
  'TIMING vs your words: by default, text you wrote before this call is SPOKEN FIRST, then the body moves ' +
  '(announce → act: "Watch this!" plays, THEN the dance starts), and the tool returns when the motion has ' +
  'actually finished — so words in your NEXT step land after the move. To gesture WHILE talking pass ' +
  'timing:"now". For an exact mid-speech moment, put a [move] tag in your text where the motion belongs and ' +
  'pass timing:"at_tag" — the tag is never spoken: "Ready? [move] Here I go!" starts the move as "Here I go!" ' +
  'begins. The move performed is always THIS call\'s steps; the tag only picks its moment.';
export const COMPUTE_DESC =
  'Evaluate a SAFE arithmetic or random-number expression and get the result back ' +
  '(e.g. math, or "random(1,10)", or "random(1,10) > 5"). Use this whenever you\'d otherwise want to ' +
  '"run code" for a quick number or a random pick — it\'s the fast path for arithmetic.';
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
export interface MoveJoint {
  part: string;
  degrees: number;
  /** RELATIVE step: `degrees` is a DELTA from this joint's current angle, not an absolute
   *  target. The executor resolves it against the live pose (see motion.ts) and clamps at the
   *  limit. This is how "turn more right" / "turn right again" work — the model doesn't need to
   *  know the current angle or pick a sign that must stay consistent across turns. */
  relative?: boolean;
}

export interface MoveStep {
  part?: string;
  degrees?: number;
  /** single-joint relative (see MoveJoint.relative). */
  relative?: boolean;
  parts?: MoveJoint[];
  duration_ms?: number;
  wait_ms?: number;
  /** Opt this step OUT of the comfortable-speed floor: an intentional snap/startle/dance
   *  beat that is MEANT to be fast. Still bounded by the firmware velocity cap. Without it,
   *  an explicit duration faster than the comfortable rate is stretched (see motion.ts). */
  snap?: boolean;
}

/** Normalize a step to its joint list ([] for a pure wait). */
export function stepJoints(step: MoveStep): MoveJoint[] {
  if (step.parts && step.parts.length > 0) return step.parts;
  if (step.part != null && step.degrees != null) return [{ part: step.part, degrees: step.degrees, relative: step.relative }];
  return [];
}
