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
  + '  • run an LLM / agent — import pi (@earendil-works/pi-agent-core), build an Agent; '
  + 'the provider API key is already in process.env. Use it for vision, classification, '
  + 'multi-step reasoning, tool use — your own loop, as powerful as you need.\n'
  + '  • call HTTP / APIs, read & write files, run shell commands, use any npm module (via `imports`).\n'
  + 'Go to the STATION (await this.<cap>()) ONLY for things that need a live resource the '
  + 'station alone holds — never to offload work you could do yourself:\n'
  + '  • this.frame() — the decoded camera image (the station already consumes the dock\'s ONE '
  + 'WebRTC stream; opening a second consumer would duplicate it).\n'
  + '  • this.notifyAgent() / askAgentInput() — reach the user (the station owns the WebSocket to '
  + 'the dock app; you have no connection to it).\n'
  + '  • this.move() / recognize — drive the body / read the face gallery (station-owned connections + state).\n'
  + 'Example — "watch for someone slouching": loop → const img = await this.frame() → ask your OWN '
  + 'Agent "is this person slouching?" about img → on a yes, await this.notifyAgent("Sit up straight!"). '
  + 'The frame and the notify go to the station; the JUDGEMENT is your own agent.\n';

const AUTHORING_RULES =
  'CRITICAL — ONE-SHOT vs RECURRING: if the job happens ONCE (e.g. "remind me in 10 minutes"), '
  + 'do the work then call this.finish() so it STOPS — do NOT loop forever. Only loop '
  + '(while (true) { … }) for genuinely REPEATING jobs ("every N", "keep watching"). Always reach '
  + 'a terminal: this.finish() on completion or this.errored() on failure. (Most one-time reminders '
  + 'are better served by the shipped remind-after task — reuse it.)\n'
  + 'One-shot example body: `await this.sleep(this.params.delay as string); await this.notifyAgent(this.params.message as string); this.finish();`\n'
  + 'Recurring example body: `while (true) { await this.sleep(this.params.interval as string); await this.notifyAgent(this.params.message as string); }`\n'
  + 'Declare inputs in `params` — any value run() relies on (e.g. interval, delay) MUST be '
  + 'required:true OR have a default; never read an undefined param. `this.params.X` is typed '
  + '`unknown`, so CAST it (e.g. `this.params.from as number`).\n'
  + '`status` is a JS expression for getStatus() — what the user sees when they ask how it is going '
  + '(e.g. `` `reminding every ${this.params.interval}` ``). Defaults to the description.\n'
  + 'IMPORTS: run() cannot add its own import lines — list any npm/node modules you use in `imports` '
  + '(e.g. "import { Agent } from \'@earendil-works/pi-agent-core\'", "import { execFile } from \'node:child_process\'").\n'
  + 'The new task is TYPECHECKED before it is saved — if write_task returns type errors, FIX the '
  + 'body/imports and call write_task again. Then start it with run_task.';

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
