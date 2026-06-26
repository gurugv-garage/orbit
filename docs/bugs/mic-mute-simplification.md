# Mic mute — why it's broken, and the simplification

**Status:** plan for review (no code changed yet). Supersedes the mic-off parts
of the v22–v24 fixes, which patched the wrong layer.

## The one-sentence bug

"Mic off" never stops the audio the station actually hears, because there are
**two independent microphone captures** and mute only stops the cosmetic one.

## The two captures

| Capture | Purpose | Stopped on mute? |
|---|---|---|
| `PerceptionService` / `PerceptionPipeline` | the **local** on-phone VAD/wake/face pipeline (drives the on-screen VAD meter, local wake) | **yes** — `PerceptionService.stop()` via `LaunchedEffect(micGranted, micMuted)` |
| `MediaStreamer.audioTrack` (WebRTC) | the **real** audio sent to the station's SFU → STT → brain | **NO.** `audioTrack.setEnabled()` is never called anywhere — only create/dispose. |

The WebRTC track is started independently on `stationConnected && perceptionReady`
and runs until screen teardown. Mute toggling does not touch it. So when you mute:
the local meter goes quiet, but the station keeps receiving audio, transcribing,
and opening listening windows. **That is the whole bug** — confirmed live: muted
dock went `idle → listening` when speech was played, and VAD/RMS activity
continued.

## Why it got this complicated — too many notions of "mic"

There are ~10 pieces of state that all touch "mic," and "mic off" only affects the
cosmetic subset:

| State | Means | Mute affects it? |
|---|---|---|
| `micMuted` (FaceController) | the user's **toggle intent** | sets a flag + Speaker label + stops local pipeline |
| `micLive` (MicLiveState) | **OS capture** state — and what the **icon shows** | NO — so the icon never reflects your tap |
| `micReady` = micLive && streamUp | icon color/pulse | NO |
| `PerceptionService` | local VAD/wake pipeline | stopped (cosmetic) |
| **`audioTrack` (WebRTC)** | **the audio the station hears** | **NO** ← the bug |
| `privacy` = mic&&cam | both-off composite | derived |
| `speaker` (Silent/User/Bot/Muted) | who's making sound | label only |
| station `#muted` (ConversationState) | server-side mute gate I added in v23 | only if the `mic-muted` frame arrives — which it may not |

Three of these (`micMuted`, `micLive`, `audioTrack`-enabled) should be **one
concept**, and they're not even wired to each other. The icon watches `micLive`,
the user controls `micMuted`, and the station hears `audioTrack` — three disagreeing
sources of truth for one on/off switch.

## What v22–v24 got wrong

The earlier fixes hardened the **station-side** mute path (a `mic-muted` frame +
`ConversationState.setMuted` + window gates). That logic is correct *in isolation*
and its unit/headless tests pass — but it's downstream of a frame that (a) isn't
reliably sent and (b) is moot, because **the audio never stops regardless**. I
verified the wrong layer. The honest status: **BUG-2 is NOT fixed in reality.**

## The simplification

Make "mic off" mean exactly **one** thing — *stop sending audio* — and make the
icon show the user's intent. Everything else collapses out.

### Core (the fix)
1. **`MediaStreamer.setMuted(muted)`** → `audioTrack?.setEnabled(!muted)`. One line.
   When muted, the WebRTC track sends silence; the station hears nothing, so STT
   produces nothing, so no listening window can open. This is the real switch.
2. **Wire it to `micMuted`**: a `LaunchedEffect(micMuted)` calls
   `mediaStreamer.setMuted(micMuted)` (and on (re)stream-start, apply the current
   value so a reconnect/restart re-asserts mute).
3. **Icon binds to intent**: `StatusBar(micOn = !micMuted ...)` instead of
   `micLive`. Tapping mute now visibly flips the icon. (Keep `micReady`/`micLive`
   only for the "connecting…" pulse, if we keep it at all — see below.)

### Persist + re-assert (the restart gaps)
4. **Persist `micMuted`** (DataStore/SharedPreferences) so an app restart doesn't
   silently re-open the mic.
5. **Re-assert on (re)connect**: applying `setMuted` on stream-start (point 2)
   covers the WebRTC side; if we keep the station frame, also re-send on
   `LaunchedEffect(stationConnected)`.

### What to DELETE (the over-engineering)
Once the audio actually stops, the station literally cannot hear a muted dock, so
the server-side mute machinery is redundant defense, not mechanism. Candidates to
revert (decide in review):
- `ConversationState.#muted` + `setMuted` + the tap/face/utterance/speakEnd guards
- `session.setMicMuted`, the `mic-muted` brain frame + handler
- `RemoteBrain.sendMicMuted` + its LaunchedEffect
- the `PerceptionWiring` mute-edge guard (the face follows the station, which now
  correctly goes idle because it hears silence)
- the v23 debug `mic-muted`/`mic-unmuted` events + the snapshot `muted`/`lastReason`
  fields I added for testing

Keeping them is "belt-and-suspenders"; deleting them is the simplification you
asked for. **Recommendation: delete** — one switch, one source of truth.

### Open question for review
- Do we still want the local `PerceptionService` to stop on mute? It's a real
  power/CPU saving (no local VAD/face work while muted) and is harmless — probably
  **keep** that one line, it's not part of the confusion.
- The mic icon currently has a "connecting…" amber pulse (`micReady`). With the
  icon bound to intent, do we keep the pulse (needs `micLive`/`streamUp`) or drop
  it for simplicity? Minor.

## Net

Before: 3 disagreeing sources of truth, audio never stops, ~10 state pieces.
After: `micMuted` is the single source → drives (a) the WebRTC track enable, (b)
the icon, (c) optionally the local pipeline. The station needs to know nothing; it
just hears silence. One concept, a handful of lines, the rest deleted.
