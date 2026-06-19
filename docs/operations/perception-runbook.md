# Perception → agent — runbook (how to run it + how to test it)

> The operational companion to the design docs. **What processes to start, in what
> order, how to verify each one, and how to exercise the whole perception→agent chain
> end-to-end** — on the console and on a real phone. Plus what's still left to build.
>
> Design/decisions live elsewhere: the pipeline ([perception-pipeline.md](../perception-pipeline.md)),
> the agent plug-in ([perception-to-brain.md](../perception-to-brain.md)), the SFU/tap
> ([media-processing.md](../media-processing.md)). This doc is "make it go + check it."

---

## 1. The processes — what runs, and why

The full pipeline is **three kinds of process** (plus the dock app on a phone):

| # | Process | Port | What it is | Needed for |
|---|---|---|---|---|
| 1 | **vision sidecar** (Python/MLX) | `:8080` | Qwen2.5-VL temporal — `/temporal` | 👁 vision snapshots |
| 2 | **STT sidecar** (Python/MLX) | `:8078` | Whisper small.en — `/transcribe` | 🎙 speech snapshots |
| 3 | **orbit-station** (Node/TS) | `:8099` | WS hub + SFU + all modules (brain, perception, memory, gate) + browser UI | everything |
| 4 | **dock app** (Android) | — | the phone: camera/mic → WebRTC, face UI, TTS | a real dock (else use the `web-test` console peer) |

In-process inside the station (no separate process): **face-api** (TF.js identity/emotion
— this is the CPU that blips when frames flow), the **SFU**, the **memory store** (sqlite
`.data/orbit.db`), the **gate watcher**. Remote, on-demand: **Gemini** (the fusion
summarizer + memory embeddings — needs `GEMINI_API_KEY` in `.env`).

```
 phone cam+mic ──WebRTC──▶ station SFU ──tap──▶ processors:
                              :8099            ├─ vision  → POST :8080/temporal  (qwen)
                                               ├─ speech  → POST :8078/transcribe (whisper)
                                               ├─ identity/emotion (face-api, in-proc)
                                               └─ bodymotion (proprioception)
                                                       │ SnapshotStore (ring)
                                   ┌───────────────────┼───────────────────┐
                              grounding            gate-watcher          memory (sqlite)
                              (per turn)        (auto self-thoughts)   (recall/lineage)
                                   └──────────▶ brain (per-dock pi session) ◀── tools
                                                       │
                                              speak / turn-status ──▶ phone TTS
```

---

## 2. Start everything (in order)

### 2a. The two MLX sidecars (Apple Silicon)

> **Easiest: the console.** Once the station is up, the **Perception Studio**
> (`/#perception`) has a **⚙ Sidecars** bar at the top — a status pill per sidecar
> (up/down + model + latency) with **▶ start / ↻ restart / ■ stop** buttons. It spawns/
> kills the processes for you (resolves the real python interpreter; stops a hand-started
> one by port). The CLI below is the equivalent if you'd rather not open the console.
> Status + control also exposed as `GET /api/perception/sidecars` and
> `POST /api/perception/sidecars/:name/{start,stop,restart}` (`:name` = `vision`|`speech`).

```bash
cd /Users/guru/garage/orbit/models/perception-sidecar

# STT (whisper small.en) on :8078
python3 sidecar.py --port 8078 --model mlx-community/whisper-small.en-mlx &

# Vision (qwen temporal) on :8080, STT disabled on this one (one model per process —
# MLX/Metal is not thread-safe; never load two models in one process).
python3 sidecar.py --port 8080 --temporal --no-stt &
```

Flags: `--temporal` preloads qwen at boot; `--no-stt` skips loading whisper; `--vision`
(unused here) would preload md3. Defaults: `--host 127.0.0.1`, `--port 8078`,
`--model …whisper-small.en-mlx`. **Verify:**

```bash
curl -s localhost:8078/health   # {ok, stt_model, vision_model}
curl -s localhost:8080/health
```

### 2b. The station

```bash
cd /Users/guru/garage/orbit/orbit-station
npm install            # first time
npm run dev            # :8099, backend serves UI; both rebuild on change
# or production-style (faster, no hot-reload — better for a test session):
npm run build && npm start
```

Needs `orbit-station/.env` with `GEMINI_API_KEY` (vision fusion + memory embeddings);
the perception snapshot pipeline runs without it but summaries/semantic-recall degrade
(grounding falls back to the raw stream, memory recall to recency). **Verify:**

```bash
curl -s localhost:8099/api/brain/docks      # [] until a dock connects
open http://localhost:8099/                 # the console
```

> **Gotcha — the stdin watchdog.** `main.ts` exits on stdin close when not a TTY (the
> dev-tree backstop). Launching the station detached from a script kills it instantly
> ("parent-exit — shutting down"). For a long-lived background run use a held-open stdin:
> `tail -f /dev/null | npm start`.

### 2c. A dock (real phone, optional)

The console's **`web-test`** peer is a fake dock — enough to test routing/tools/memory,
but it has **no camera/mic**, so vision/identity/gate can't fire from it. For the real
pipeline, connect a phone:

```bash
cd /Users/guru/garage/orbit/node-dock/app
./gradlew :app:installDebug                 # sideload (STATION_URL in local.properties)
# USB tether so the phone reaches the station:
adb reverse tcp:8099 tcp:8099
adb shell monkey -p dev.orbit.dock -c android.intent.category.LAUNCHER 1
```

The app connects over the LAN (or the reverse tunnel) to `:8099/ws`. **Verify it's online:**

```bash
curl -s localhost:8099/api/docks | python3 -m json.tool   # component "phone" online:true
```

### Env knobs (all optional, sane defaults)

| Var | Default | Effect |
|---|---|---|
| `TEMPORAL_SIDECAR_URL` | `http://127.0.0.1:8080` | vision sidecar |
| `PERCEPTION_SIDECAR_URL` | `http://127.0.0.1:8078` | STT sidecar |
| `PERCEPTION_SUMMARY_MODEL` | `gemini-2.5-flash` | fusion summarizer |
| `MEMORY_EMBED_MODEL` | `gemini-embedding-001` | memory semantic recall |
| `VISION_WINDOW_FRAMES` | `5` | frames per vision analysis |
| `PERCEPTION_SNAPSHOT_CAP` | `1000` | snapshot ring size |
| `STT_ENDPOINT_MS` | `1300` | trailing-silence to end an utterance |

---

## 3. Test the pipeline — automated

```bash
cd /Users/guru/garage/orbit/orbit-station/server
npm test                                    # full suite (278 tests, all green)

# focused:
npx tsx --test "src/modules/perception/**/*.test.ts"   # store, gate, watcher, grounding…
npx tsx --test "src/modules/brain/*.test.ts"           # routing, tools, integration
```

> **tsx test gotcha:** `npx tsx --test --test-force-exit <file>` sometimes does NOT exit
> under tsx and spins a CPU. Run **without** `--test-force-exit` and it exits cleanly:
> `npx tsx --test <file>`. (Watch for runaway `tsx … --test` procs after a test session;
> `pkill -f "<file>.test.ts"` if needed.)

**Key test files (per phase, foundation-first — pure core unit-tested, then wired, then E2E):**

| Phase | Pure/unit | Integration / E2E |
|---|---|---|
| 1 thoughts | `brain/thought-router.test.ts` | `brain/autonomous.test.ts` (state routing) |
| 2 grounding | `perception/grounding.test.ts` | `brain/integration.test.ts` (→ system prompt) |
| 3 force_get_current | `brain/tools.test.ts` | (live via console / phone) |
| 4 memory | `perception/memory/store.test.ts` | `brain/tools.test.ts` + `brain/integration.test.ts` |
| 5 gate | `perception/attention/gate.test.ts`, `gate-watcher.test.ts` | `perception/attention/gate-e2e.test.ts` (snapshot→gate→session→speak) |

---

## 4. Test the pipeline — console (Playwright headful)

The Brain console (`/#brain`) is the manual test surface. Connect (set **dock** =
`web-test` or your real dock, click **connect**) → the **👁 PERCEPT** strip appears with:

- **state pill** + **🎙 listening** toggle — flip listening, fire a thought, watch it DEFER then run.
- **think box → fire thought** — inject a `trigger.kind:'self'` thought (Phase 2c). *Manual text, not perception-fed.*
- **🔎 perceive now** — a user turn that should call `force_get_current` (Phase 3c).
- **▸ grounding** — preview the exact perception block the next turn injects (Phase 2).
- **▸ memory** — list/search memories, click → lineage ("why do I believe this"), forget (Phase 4c).
- **▸ proactivity** — toggle the gate on/off + the recent-decisions log (Phase 5c).

The driver scripts used during development (adapt the dock name as needed):
`/tmp/test-2c.mjs` … `test-5c.mjs` — `node <script>` with the station up. They launch a
real headful Chromium, exercise each surface, and screenshot to `/tmp/*-console.png`.
**Always close them cleanly** (the scripts do); a leftover headful Chromium burns CPU.

---

## 5. Test end-to-end — on a real phone

With a phone online (§2c), drive turns via the debug broadcast receiver and observe via REST:

```bash
DOCK=anne-bot   # your dock name

# (1) SELF-THOUGHT → the phone speaks it
curl -s -X POST localhost:8099/api/brain/$DOCK/think -H 'content-type: application/json' \
  -d '{"text":"[you notice it has been quiet] say something light"}'

# (2) force_get_current — a now-turn drives the live camera → vision → gemini summary
adb shell "am broadcast -a dev.orbit.dock.debug.SAY -e text 'what do you see right now'"

# (3) MEMORY — remember then recall across turns
adb shell "am broadcast -a dev.orbit.dock.debug.SAY -e text 'remember I prefer green tea'"
adb shell "am broadcast -a dev.orbit.dock.debug.SAY -e text 'what do I like to drink'"

# (4) PROACTIVE GATE — enable, then step into the camera frame
curl -s -X POST localhost:8099/api/perception/gate -H 'content-type: application/json' -d '{"enabled":true}'
#   …walk into view → face recognized → gate raises → the phone greets UNPROMPTED.
curl -s -X POST localhost:8099/api/perception/gate -H 'content-type: application/json' -d '{"enabled":false}'  # restore default
```

**Observe (no UI needed):**

```bash
# the turn transcript (did the thought run? did a tool fire? what was spoken?)
curl -s localhost:8099/api/brain/$DOCK/history | python3 -c "import sys,json;[print(m.get('role'),':',(m.get('content') if isinstance(m.get('content'),str) else ' '.join(c.get('text','') for c in m.get('content',[]) if isinstance(c,dict)))[:200]) for m in json.load(sys.stdin)[-6:]]"

# the live snapshot streams (is identity/vision flowing?)
curl -s "localhost:8099/api/perception/snapshots?limit=300" | python3 -c "import sys,json;from collections import Counter;r=json.load(sys.stdin);print(Counter(x['source']['kind'] for x in r if x['dockId']=='$DOCK'))"

# the dock's memories
curl -s "localhost:8099/api/perception/memory?dock=$DOCK"

# gate state + recent decisions
curl -s localhost:8099/api/perception/gate
```

**Verified working on real hardware (2026-06): all of (1)–(4).** The capstone: with the
gate on, stepping into frame produced an unprompted *"Hi Guru! I see you're back. I
remember you prefer green tea over coffee!"* — gate (5) + self-thought (1) + memory (4)
fused in one autonomous greeting.

> **Known real-world flakiness (not a code bug):** the live **identity/face stream
> flickers** ("Guru" → "no one" → "Guru" every few seconds) and is sparse vs. vision —
> the camera/SFU tap drops out intermittently. The gate's cooldown/dedup absorbs it (no
> greeting spam), but face-stream **stability is worth tightening** separately (see §6).

---

## 6. What remains (not yet built)

Server-side Phases 1–5 are complete + tested. Outstanding:

- **A1 — the always-on-mic APP shift (the big dependency).** Today the Android recognizer
  owns the mic and sends only finalized utterances, so the station has **no live
  user-speech signal / continuous transcript**. Moving the mic into the WebRTC/perception
  path is what makes REAL: the `listening` state (currently a stubbed flag), speech
  **segmentation** (what exact text a turn carries), and the gate's **conversation-relevance
  tier** (currently `signals.relevance` is always undefined). Plus **echo cancellation +
  voice barge-in** ship with it. Substantial app work; its own design pass —
  see [perception-to-brain.md](../perception-to-brain.md) Decision 2b/2c + Open questions.
- **Gate LLM-judge tier.** The gate is cheap-rules only (arrival/emotion). The pyramid's
  next tier is a small-LLM judge that decides "worth interjecting?" from richer context —
  upgrade over the rules, gated by A1 for the conversation half.
- **"Think from perception" button.** A console button between the manual think-box and
  the autonomous gate: flush + summarize the live moment, fire THAT summary as a
  self-thought. All pieces exist (`force_get_current` + `/think`); just not wired into one.
- **Memory follow-up:** retention/rollup tiers (how long raw vs summaries; per-dock
  budgets); the **gallery → unified-store migration** (the face gallery still runs as its
  own JSON, coupled to the module but not yet a `type:'person'` view over the memory store
  — [perception-to-brain.md](../perception-to-brain.md) 4.5/4.6); grounding's memory-selection
  (which memories to inject by recency × relevance × confidence).
- **Face-stream stability** (§5): the intermittent identity tap. A perception-pipeline fix,
  independent of the agent work.
- **Bodymotion is dormant** until the robot body feeds real motion commands (today it's
  proprioception-ready but the ESP32 body was offline in testing).

---

## 7. Shutdown / housekeeping

```bash
# stop the station (frees :8099); sidecars keep their models warm for next time
lsof -tiTCP:8099 -sTCP:LISTEN | xargs kill

# stop the sidecars too
pkill -f "sidecar.py"

# the dock session + memories persist in .data/orbit.db (survives restart).
# wipe ONLY for a clean-slate test (also drops config/obs/sessions):
#   rm .data/orbit.db .data/orbit.db-wal .data/orbit.db-shm
```

**Footprint at idle** (measured): station ~0–3% CPU / ~610 MB; each sidecar ~0% / ~350 MB
(models resident); ~1.35 GB total of the ~4 GB always-on budget. Face-api briefly spikes
the station CPU when frames flow — normal.
