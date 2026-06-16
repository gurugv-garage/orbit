/**
 * The task-authoring prompt — the `write_task` tool's description. Extracted from
 * tools.ts so the static how-to and the DOCK-SPECIFIC capability advertisement
 * compose cleanly. Built per-dock (buildTaskTools passes the dock's capability ad),
 * so the LLM only ever sees the primitives + the capabilities THIS dock has.
 */

/** The core authoring guidance — the Task primitives + the one-shot/recurring +
 *  params/imports/typecheck rules. Dock-independent. */
const PRIMITIVES =
  'CREATE a new background task when no existing definition fits (check list_tasks first). '
  + 'A task runs as its OWN process. You write the `body` of an `async run()` method on a class '
  + 'that already extends our Task base (it handles connecting + messaging). `body` is plain '
  + 'JavaScript that does whatever the request needs (loop on a timer, react to events, call an '
  + 'API, multi-step jobs) using `this`:\n'
  + '• this.params.<name> — the inputs you declared in params\n'
  + '• await this.notifyAgent(text, image?) — push an update to the user (only when useful)\n'
  + '• this.status(text) — set the status the user can pull anytime via get_task_status\n'
  + '• this.finish(summary) — done;  this.errored(why) — failed\n'
  + '• await this.sleep("5s") — wait (string duration or ms number)\n'
  + '• const answer = await this.askAgentInput(prompt) — ask the user and AWAIT their answer\n'
  + '• this.state.<k> = …; this.checkpoint() — optional: persist state so a resume reloads it\n';

/**
 * SELF vs STATION — the core mental model an author must hold. A task is just
 * station-local code in the same environment; it does almost everything ITSELF and
 * only goes to the station for the few things that need the station's live
 * in-process resources. Exported so the doc and the prompt share one source.
 */
export const SELF_VS_STATION =
  'WHAT YOU DO YOURSELF vs WHAT YOU ASK THE STATION FOR — a task is a real Node '
  + 'process in the SAME environment as the station (same machine, same .env keys, '
  + 'same node_modules, same filesystem/network). So do almost EVERYTHING yourself, '
  + 'directly in run():\n'
  + '  • run an LLM — the base class gives you `this.agent` (a ready pi Agent: the dock\'s model + '
  + 'the env API key, already wired) and `this.ask(content)` (one-shot → the text answer). Use it for '
  + 'vision, classification, summarization, multi-step reasoning — as powerful as you need. NO setup, '
  + 'NO imports, NO key handling. (For richer/multi-turn use `this.agent` directly; it is pi\'s Agent.)\n'
  + '  • call HTTP / APIs, read & write files, run shell commands, use any npm module (via `imports`).\n'
  + '  • SLACK is built in (a SELF action — NO capability, NO import, NO setup; the bot token is in the env): '
  + '`await this.sendToSlack("hello *world*", "#orbit-channel")` to post a message, '
  + '`await this.sendPhotoToSlack({ channel: "#orbit-channel", caption: "..." })` to take a CAMERA PHOTO and post it '
  + '(it grabs the frame itself), or `await this.dmOnSlack("alice", "...")` to DM a person. '
  + 'omit the channel to use the configured default. (Only the photo PIXELS come from the station, via this.frame().)\n'
  + 'Go to the STATION (await this.<cap>()) ONLY for things that need a live resource the '
  + 'station alone holds — never to offload work you could do yourself:\n'
  + '  • this.frame() — the decoded camera image (the station already consumes the dock\'s ONE '
  + 'WebRTC stream; opening a second consumer would duplicate it).\n'
  + '  • this.notifyAgent() / askAgentInput() — reach the user (the station owns the WebSocket to '
  + 'the dock app; you have no connection to it).\n'
  + '  • this.move() / recognize — drive the body / read the face gallery (station-owned connections + state).\n'
  + 'REASONING / VISION — NEVER fake it (no Math.random(), no stub). Use YOUR OWN LLM:\n'
  + '  • text/judgement: `const verdict = await this.ask([{ type: "text", text: "Classify this note as '
  + 'urgent or not: " + note }]);`\n'
  + '  • vision: grab the frame, then ask your agent about it — `const frame = await this.frame(); '
  + 'const ans = await this.ask([{ type: "text", text: "How many fingers are held up?" }, '
  + '{ type: "image", data: frame, mimeType: "image/jpeg" }]);`\n'
  + '  • SUGAR for the common image yes/no (optional): import `isTrueInImage` / `askVision` from the '
  + 'harness — `imports: ["import { isTrueInImage } from \'../../_harness/index.js\'"]`, then '
  + '`await isTrueInImage("exactly five fingers are held up", frame)` → boolean.\n'
  + '  CHOOSING THE MODEL — if (and ONLY if) your task calls an LLM (this.ask/this.agent/vision), pass '
  + 'the `model` arg to set what it runs on; a plain reminder/timer/watcher with no this.ask needs NO '
  + 'model (omit it). Trade SPEED vs ACCURACY: a TIGHT loop that polls often (e.g. a 2s camera watcher) '
  + 'wants the FASTEST model so each pass is quick — every this.ask BLOCKS the loop (a slow model can make '
  + 'a "2s" loop actually ~5s); a one-shot careful JUDGEMENT wants the STRONGEST. The model choice is '
  + 'BAKED INTO the task; the user can ask you to switch it later (it is just another task edit).\n'
  + '  NO-CAMERA CASE: this.frame() returns undefined when the dock is not streaming. Do NOT silently '
  + 'skip — keep the user informed via this.status() (and keep checking, the stream may come back).\n'
  + '  A recurring camera watcher, EDGE-TRIGGERED so it fires ONCE per occurrence (not every frame):\n'
  + '    `let armed = true;\n'
  + '     while (true) {\n'
  + '       const frame = await this.frame();\n'
  + '       if (!frame) { this.status("waiting for camera (no video stream)"); await this.sleep("3s"); continue; }\n'
  + '       const yes = await isTrueInImage("exactly five fingers are held up", frame);\n'
  + '       this.status(yes ? "five fingers SEEN" : "watching — not seen");\n'
  + '       if (yes && armed) { await this.notifyAgent("Hi!"); armed = false; }\n'
  + '       else if (!yes) { armed = true; }   // re-arm once it is no longer true\n'
  + '       await this.sleep("2s");\n'
  + '     }`\n';

const AUTHORING_RULES =
  'CRITICAL — ONE-SHOT vs RECURRING: if the job happens ONCE (e.g. "remind me in 10 minutes"), '
  + 'do the work then call this.finish() so it STOPS — do NOT loop forever. Only loop '
  + '(while (true) { … }) for genuinely REPEATING jobs ("every N", "keep watching"). Always reach '
  + 'a terminal: this.finish() on completion or this.errored() on failure. (Most one-time reminders '
  + 'are better served by a SHIPPED task — REUSE, do not re-author: remind-after for "in N minutes/'
  + 'hours" (delay), remind-at for "at TIME of day" e.g. "at 7:20pm"/"at 19:20" (time). Do NOT '
  + 'hand-write clock/timezone parsing — remind-at already handles formats + the past-midnight roll.)\n'
  + 'One-shot example body: `await this.sleep(this.params.delay as string); await this.notifyAgent(this.params.message as string); this.finish();`\n'
  + 'Recurring example body: `while (true) { await this.sleep(this.params.interval as string); await this.notifyAgent(this.params.message as string); }`\n'
  + 'Declare inputs in `params` — any value run() relies on (e.g. interval, delay) MUST be '
  + 'required:true OR have a default; never read an undefined param. `this.params.X` is typed '
  + '`unknown`, so CAST it (e.g. `this.params.from as number`).\n'
  + '`status` is a JS expression for getStatus() — what the user sees when they ask how it is going '
  + '(e.g. `` `reminding every ${this.params.interval}` ``). Defaults to the description.\n'
  + 'IMPORTS — CRITICAL: NEVER write an `import` line inside `body` (it is a function body; an import '
  + 'there is a TypeScript error). Put EVERY module you need in the `imports` array argument, then just '
  + 'use it in `body`. e.g. imports: ["import { Agent } from \'@earendil-works/pi-agent-core\'", '
  + '"import { execFile } from \'node:child_process\'"], and body references Agent/execFile directly.\n'
  + 'The new task is TYPECHECKED before it is saved — if write_task returns type errors, READ the fix '
  + 'hint, correct the body/imports, and call write_task AGAIN (do not give up — retry until it saves). '
  + 'Then start it with run_task.';

/**
 * The full `write_task` description for a dock. `capabilityAd` is the dock's
 * available station capabilities (from CapabilityRegistry.advertiseFor) — empty
 * for a dock with no extra capabilities. Spliced between the base primitives and
 * the authoring rules.
 */
export function writeTaskDescription(capabilityAd = ''): string {
  const caps = capabilityAd.trim() ? capabilityAd.trim() + '\n' : '';
  // primitives → the self-vs-station guideline → this dock's capabilities → rules.
  return PRIMITIVES + SELF_VS_STATION + caps + AUTHORING_RULES;
}
