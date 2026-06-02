#!/usr/bin/env bash
# Interactive BodyLink client for the dock body firmware.
#
# Speaks the redesigned protocol from bodylink/DESIGN.md:
#   - handshake: receive event:boot → send hello → receive welcome + profile
#   - command:   set_target (one or many parts; per-part idempotent), echo
#   - body emits: error, event, echo_reply (no state stream)
#
# Run it, follow the prompt. Type `help` at the menu to see commands.
#
# Usage:
#   scripts/test_body.sh                       # default host 192.168.1.10
#   scripts/test_body.sh 192.168.1.10
#   scripts/test_body.sh --host 192.168.1.10
#   scripts/test_body.sh --help

set -euo pipefail

usage() {
  cat <<'EOF'
test_body.sh — interactive BodyLink tester

USAGE:
  test_body.sh [host[:port]]
  test_body.sh --host host[:port]
  test_body.sh --help | -h

ARGS:
  host         IP or hostname of the dock body (default 192.168.1.10)
               You can also pass `host:port` to override port 17317.

ENV:
  WS_PORT      Default port (default 17317; overridden by host:port arg)

MENU COMMANDS (typed at the prompt after connect):
  help                    show in-session help
  status                  print last-commanded values, connection info

  neck <us>               move neck — pulse_width_us, default 400 ms duration
  foot <us>               move foot — pulse_width_us, default 400 ms duration
  neck <us> <ms>          custom duration_ms
  foot <us> <ms>

  up                      shorthand: neck → 1245 µs over 400 ms
  down                    shorthand: neck → 1755 µs over 400 ms
  left                    shorthand: foot → 1000 µs over 500 ms
  right                   shorthand: foot → 2000 µs over 500 ms
  center                  every part → 1500 µs
  home                    every part → its declared home pose

  target neck=<us> foot=<us> [ms=<ms>]
                          move both parts together in one frame
  raw <part> <param>=<value> ...
                          arbitrary params on one part
                          (e.g. raw neck pulse_width_us=1500 duration_ms=400)
  echo                    diagnostic round-trip
  wait <ms>                sleep N ms (useful inside batch)
  json <envelope JSON>    send a raw envelope (advanced; no validation)

  quit / exit / Ctrl-D    leave

BATCHING (`;` separator):
  Multiple commands on one line, joined with `;`, are **collapsed into a
  single set_target frame** when they target different parts — so neck
  and foot start moving at exactly the same time.

    body> neck 1245; foot 2000             # both servos move in parallel
    body> neck 1245 500; foot 2000 800     # different durations, same start
    body> up; right                        # shortcuts merged into one set_target

  Other (non-motion) commands chained with `;` run sequentially with a
  small gap. Use `wait <ms>` to insert an explicit pause:

    body> up; wait 600; down; wait 600; center

  If multiple commands target the SAME part on one line, the last one
  wins (you can't override yourself in the same frame).

NOTES:
  Pulse-width range: 500–2500 µs. Out-of-range values are clipped by
  the firmware and you'll see an error + event:clipped pair. set_target
  is fire-and-forget — silence = success.
EOF
}

# ── Arg parsing ────────────────────────────────────────────────────────
HOST="192.168.1.10"
PORT="${WS_PORT:-17317}"
HOST_RAW=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --host)    shift; HOST_RAW="$1"; shift ;;
    *)         HOST_RAW="$1"; shift ;;
  esac
done
if [[ -n "$HOST_RAW" ]]; then
  if [[ "$HOST_RAW" == *:* ]]; then
    HOST="${HOST_RAW%:*}"
    PORT="${HOST_RAW##*:}"
  else
    HOST="$HOST_RAW"
  fi
fi

# ── Node + ws module resolution ────────────────────────────────────────
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "error: node not on PATH. Install Node (nvm) and retry." >&2
  exit 1
fi
WSCAT="$(command -v wscat || true)"
if [[ -z "$WSCAT" ]]; then
  echo "error: wscat not on PATH. Install with: npm i -g wscat" >&2
  exit 1
fi
WSCAT_DIR="$(dirname "$(readlink -f "$WSCAT" 2>/dev/null || echo "$WSCAT")")"
WS_MODULE="$(dirname "$WSCAT_DIR")/lib/node_modules/wscat/node_modules/ws"
if [[ ! -d "$WS_MODULE" ]]; then
  WS_MODULE="$(npm root -g 2>/dev/null)/wscat/node_modules/ws"
fi
if [[ ! -d "$WS_MODULE" ]]; then
  echo "error: couldn't find the ws module bundled with wscat." >&2
  exit 1
fi

# ── REPL driver in Node ────────────────────────────────────────────────
exec env HOST="$HOST" PORT="$PORT" WS_MODULE="$WS_MODULE" "$NODE" -e '
const WebSocket = require(process.env.WS_MODULE);
const readline  = require("readline");

const host = process.env.HOST;
const port = process.env.PORT;
const url  = `ws://${host}:${port}/`;

const colors = {
  recv:  "\x1b[36m", send: "\x1b[33m", ok: "\x1b[32m",
  err:   "\x1b[31m", dim: "\x1b[90m",  reset: "\x1b[0m",
};
const c = (k, s) => process.stdout.isTTY ? colors[k] + s + colors.reset : s;

console.log(c("dim", `BodyLink tester — connecting to ${url}`));

const ws = new WebSocket(url);
let connected = false;
let handshakeDone = false;
let profile = null;
const last = { neck: 1500, foot: 1500 };

const send = (obj) => {
  const env = Object.assign({ v: 0, ts: Date.now() }, obj);
  const json = JSON.stringify(env);
  console.log(c("send", "> " + json));
  ws.send(json);
};

ws.on("open", () => {
  connected = true;
  console.log(c("ok", "[connected]"));
  setTimeout(() => send({ type: "hello", body: { protos: [0] } }), 150);
});

ws.on("message", (data) => {
  let m;
  try { m = JSON.parse(data.toString()); }
  catch { console.log(c("recv", "< (non-JSON) " + data.toString())); return; }

  if (m.type === "welcome") {
    console.log(c("ok",
      `< welcome  device_id=${m.body.device_id}  name=${m.body.name}  fw=${m.body.fw_version}  proto=${m.body.proto}`));
  } else if (m.type === "profile") {
    profile = m.body;
    const parts = Object.keys(profile.parts || {}).join(", ");
    console.log(c("ok", `< profile  parts=[${parts}]`));
    handshakeDone = true;
    showMenuHeader();
  } else if (m.type === "event" && m.body.kind === "boot") {
    console.log(c("recv", "< event:boot"));
  } else if (m.type === "event") {
    console.log(c("recv", "< event  " + JSON.stringify(m.body)));
  } else if (m.type === "error") {
    console.log(c("err",  "< error  " + JSON.stringify(m.body)));
  } else if (m.type === "echo_reply") {
    const rtt = Date.now() - m.body.host_ts;
    console.log(c("ok", `< echo_reply  seq=${m.body.seq}  rtt=${rtt}ms`));
  } else {
    console.log(c("recv", "< " + JSON.stringify(m)));
  }
});

ws.on("close", (code) => {
  console.log(c("err", `[disconnected]  code=${code}`));
  process.exit(0);
});
ws.on("error", (e) => {
  console.log(c("err", "[ws-error] " + e.message));
  process.exit(1);
});

function showMenuHeader() {
  console.log("");
  console.log(c("dim", "Connected. Type a command, or `help`, `quit` to exit."));
  rl.prompt();
}

const HELP = `
Commands
  help                          show this menu
  status                        last-commanded values + profile parts
  neck <us> [<ms>]              move neck (default 400ms)
  foot <us> [<ms>]              move foot (default 400ms)
  up | down                     neck shortcuts (1245 / 1755 over 400ms)
  left | right                  foot shortcuts (1000 / 2000 over 500ms)
  center                        every part → 1500
  home                          every part → its declared home pose
  target neck=<us> foot=<us> [ms=<ms>]
                                move both parts together in one frame
  raw <part> <key>=<val> ...    arbitrary params on one part
  echo                          round-trip latency probe
  wait <ms>                     sleep N ms (mainly for use in batches)
  json <envelope JSON>          send a raw envelope (advanced)
  quit | exit                   leave

Batch:
  Separate commands with ";". Motion commands on different parts on
  one line auto-merge into a single set_target frame, so both servos
  start moving at the SAME instant.
    body> neck 1245; foot 2000             both move in parallel
    body> up; right                         same idea via shortcuts
    body> neck 1245 500; foot 2000 800     parallel start, diff durations

  Use \`wait <ms>\` to pace sequenced moves:
    body> up; wait 600; down; wait 600; center
`;

// Single-part move — emits a set_target with one entry under body.parts.
// (We keep `setParam` as the JS name for the helper since callers think
// in "move one part" terms; the wire payload is just set_target.)
function setParam(part, us, durationMs) {
  if (!handshakeDone) { console.log(c("err", "(not handshaked yet)")); return; }
  us = parseInt(us, 10);
  if (Number.isNaN(us)) { console.log(c("err", "bad us value")); return; }
  const partBody = { pulse_width_us: us };
  if (durationMs !== undefined) partBody.duration_ms = parseInt(durationMs, 10);
  last[part] = us;
  send({ type: "set_target", body: { parts: { [part]: partBody } } });
}

function setTarget(neckUs, footUs, ms) {
  if (!handshakeDone) { console.log(c("err", "(not handshaked yet)")); return; }
  const parts = {};
  if (neckUs !== undefined) {
    parts.neck = { pulse_width_us: parseInt(neckUs, 10) };
    if (ms) parts.neck.duration_ms = parseInt(ms, 10);
    last.neck = parts.neck.pulse_width_us;
  }
  if (footUs !== undefined) {
    parts.foot = { pulse_width_us: parseInt(footUs, 10) };
    if (ms) parts.foot.duration_ms = parseInt(ms, 10);
    last.foot = parts.foot.pulse_width_us;
  }
  send({ type: "set_target", body: { parts } });
}

let echoSeq = 0;
function doEcho() {
  send({ type: "echo", id: "probe-" + (++echoSeq),
         body: { seq: echoSeq, host_ts: Date.now() } });
}

// Resolve one motion-style step into a `{part: {pulse_width_us, duration_ms?}}`
// entry suitable for merging into a set_target. Returns null if the step
// is not a motion command (so the caller should flush + run it normally).
//
// Motion commands recognised here: neck, foot, up, down, left, right.
// (`center` is also motion but writes to BOTH parts — flush-then-run.)
// (`target ...` is already a set_target — flush-then-run.)
function parseMotion(line) {
  const p = line.split(/\s+/);
  const cmd = p[0].toLowerCase();
  switch (cmd) {
    case "neck":
    case "foot": {
      const us = parseInt(p[1], 10);
      if (Number.isNaN(us)) return { _err: "bad us value" };
      const out = { part: cmd, pulse_width_us: us };
      if (p[2] !== undefined) {
        const ms = parseInt(p[2], 10);
        if (!Number.isNaN(ms)) out.duration_ms = ms;
      }
      return out;
    }
    case "up":    return { part: "neck", pulse_width_us: 1245, duration_ms: 400 };
    case "down":  return { part: "neck", pulse_width_us: 1755, duration_ms: 400 };
    case "left":  return { part: "foot", pulse_width_us: 1000, duration_ms: 500 };
    case "right": return { part: "foot", pulse_width_us: 2000, duration_ms: 500 };
    default:      return null;
  }
}

// Send a set_target whose body.parts is the merged map.
function sendBatch(parts) {
  if (!handshakeDone) { console.log(c("err", "(not handshaked yet)")); return; }
  const keys = Object.keys(parts);
  if (keys.length === 0) return;
  // Update mirror state.
  for (const k of keys) {
    if (parts[k].pulse_width_us !== undefined && last[k] !== undefined) {
      last[k] = parts[k].pulse_width_us;
    }
  }
  send({ type: "set_target", body: { parts } });
}

// Execute one command (no `;` allowed here). Returns a delay (ms) to
// wait before the next command — used by the batch driver. 0 = default
// small gap; >0 = explicit `wait` step.
function runCommand(line, isBatch) {
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  switch (cmd) {
    case "help":   process.stdout.write(HELP); return 0;
    case "status":
      console.log(`host=${url}  handshake=${handshakeDone}`);
      console.log(`last:  neck=${last.neck}µs  foot=${last.foot}µs`);
      if (profile) console.log(`parts: ${Object.keys(profile.parts).join(", ")}`);
      return 0;
    case "neck":
    case "foot":
      setParam(cmd, parts[1], parts[2]); return 0;
    case "up":     setParam("neck", 1245, 400); return 0;
    case "down":   setParam("neck", 1755, 400); return 0;
    case "left":   setParam("foot", 1000, 500); return 0;
    case "right":  setParam("foot", 2000, 500); return 0;
    case "center": setTarget(1500, 1500, 400); return 0;
    case "home": {
      if (!handshakeDone || !profile) {
        console.log(c("err", "(not handshaked yet)")); return 0;
      }
      const parts = {};
      for (const [pname, pdef] of Object.entries(profile.parts || {})) {
        const home = pdef && pdef.home;
        if (home && typeof home.pulse_width_us === "number") {
          parts[pname] = { pulse_width_us: home.pulse_width_us, duration_ms: 400 };
          if (last[pname] !== undefined) last[pname] = home.pulse_width_us;
        }
      }
      if (Object.keys(parts).length === 0) {
        console.log(c("err", "no parts with a home pose in the profile")); return 0;
      }
      send({ type: "set_target", body: { parts } });
      return 0;
    }
    case "target": {
      let neckUs, footUs, ms;
      for (let i = 1; i < parts.length; i++) {
        const [k, v] = parts[i].split("=");
        if (k === "neck") neckUs = v;
        else if (k === "foot") footUs = v;
        else if (k === "ms" || k === "duration_ms") ms = v;
      }
      setTarget(neckUs, footUs, ms);
      return 0;
    }
    case "raw": {
      if (parts.length < 3) { console.log(c("err", "raw <part> <key>=<val> ...")); return 0; }
      const partName = parts[1];
      const partBody = {};
      for (let i = 2; i < parts.length; i++) {
        const [k, v] = parts[i].split("=");
        if (k && v !== undefined) partBody[k] = isNaN(+v) ? v : +v;
      }
      if (partBody.pulse_width_us !== undefined && last[partName] !== undefined) {
        last[partName] = partBody.pulse_width_us;
      }
      send({ type: "set_target", body: { parts: { [partName]: partBody } } });
      return 0;
    }
    case "echo":   doEcho(); return 0;
    case "wait": {
      const ms = parseInt(parts[1], 10);
      if (Number.isNaN(ms) || ms < 0) {
        console.log(c("err", "wait <ms>  (positive integer)")); return 0;
      }
      if (isBatch) {
        // Inside a batch, the next command waits this long.
        return ms;
      }
      // Standalone: sleep then return — done by caller via the returned delay.
      return ms;
    }
    case "json": {
      const rest = line.substring(4).trim();
      try { ws.send(rest); console.log(c("send", "> " + rest)); }
      catch (e) { console.log(c("err", "json send failed: " + e.message)); }
      return 0;
    }
    case "quit":
    case "exit":   ws.close(); return -1;   // sentinel
    default:
      console.log(c("err", `unknown command: ${cmd}  (type "help")`));
      return 0;
  }
}

// Default inter-step gap when the user did not insert an explicit `wait`.
// Small enough to feel snappy, big enough that a quick burst of sends
// does not hammer the body in a single tick.
const DEFAULT_BATCH_GAP_MS = 50;

const rl = readline.createInterface({
  input: process.stdin, output: process.stdout, prompt: "body> ",
});
rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) { rl.prompt(); return; }
  const steps = line.split(";").map(s => s.trim()).filter(Boolean);
  if (steps.length === 0) { rl.prompt(); return; }
  const isBatch = steps.length > 1;

  // Walk steps left→right, coalescing consecutive motion commands into
  // one set_target send. Non-motion commands (wait/echo/status/etc.)
  // flush the pending motion batch first.
  let i = 0;
  let pending = {};   // {part: {pulse_width_us, duration_ms?}}

  const flush = () => {
    if (Object.keys(pending).length > 0) {
      sendBatch(pending);
      pending = {};
    }
  };

  const runNext = () => {
    if (i >= steps.length) {
      flush();
      rl.prompt();
      return;
    }
    const step = steps[i++];
    const motion = parseMotion(step);
    if (motion) {
      if (motion._err) { console.log(c("err", motion._err)); runNext(); return; }
      // Add (or override — last wins) to the pending batch.
      const { part, pulse_width_us, duration_ms } = motion;
      pending[part] = { pulse_width_us };
      if (duration_ms !== undefined) pending[part].duration_ms = duration_ms;
      runNext();
      return;
    }
    // Non-motion command. Flush motion first, then run.
    flush();
    let delay;
    try { delay = runCommand(step, isBatch); }
    catch (e) { console.log(c("err", "error: " + e.message)); delay = 0; }
    if (delay === -1) return;   // quit/exit
    const wait = delay > 0 ? delay : (isBatch ? DEFAULT_BATCH_GAP_MS : 0);
    if (wait > 0) setTimeout(runNext, wait);
    else runNext();
  };
  runNext();
});
rl.on("close", () => { try { ws.close(); } catch (e) {} });

setTimeout(() => {
  if (!connected) {
    console.log(c("err", "[timeout] failed to connect"));
    process.exit(2);
  }
}, 5000);
'
