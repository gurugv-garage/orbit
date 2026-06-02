# plat — orbit central platform service (stub)

Central platform service of the [orbit](../) platform.

Runs on laptop / home server / cloud. One process tree containing:

- **WebRTC SFU** (LiveKit or Pion) — receives audio + video from all docks
- **Per-stream audio:** Silero VAD → utterance chunking → faster-whisper STT
- **Per-stream video:** MediaPipe BlazeFace face presence per dock
- **Presence fusion:** per-dock "user is here" flag
- **LLM** (TBD) — receives transcripts + presence + rover state, emits responses + intents
- **TTS** (Piper) — routed back over WebRTC to the active dock
- **Rover bridge** (ROS2 bridge or native ROS2 node) — for navigation/manipulation intents
- **World model:** user location, rover pose, conversation context, location → map-coord mapping

**Status:** stub. Nothing built yet. Design lives in [`../docs/plan.md`](../docs/plan.md) §5.

## Next steps

1. Pick the WebRTC SFU (LiveKit vs Pion) — see `../docs/plan.md` §8
2. Skeleton single-process Python/Go service: WebRTC SFU + STT + TTS loop with one fake dock
3. ROS2 bridge to `node-rover` for navigate-to-pose intents
4. LLM tool-use schema (navigate-to-room, find-person, grab-object, speak)
