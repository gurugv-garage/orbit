# scripts/

Helpers for testing the dock app outside the IDE.

## `stt-smoke.sh`

End-to-end smoke test for the speech-to-text path. Speaks a phrase via
macOS `say`, captures logcat, and verifies a `Transcript` event lands on
the perception bus with at least 2 matching words.

### Prereqs

- Emulator running, app installed
- **Extended Controls → Microphone → "Enable Host Microphone Access"** = ON
- macOS Privacy & Security → Microphone → "Android Studio" granted

For best reliability, install [BlackHole](https://github.com/ExistentialAudio/BlackHole)
and route `say` output through it as the default macOS Mic Input — that
bypasses the acoustic loopback from speakers to laptop mic.

### Usage

```bash
./scripts/stt-smoke.sh                           # default phrase
./scripts/stt-smoke.sh "what is two plus two"    # custom phrase
TIMEOUT_S=20 ./scripts/stt-smoke.sh              # longer wait
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | transcript matched at least 2 spoken words |
| 1 | no transcript or fewer than 2 word matches |
| 2 | adb / emulator missing |
| 3 | app not running |

### Failure diagnostics

The script reads logcat to give a targeted root cause when STT silently
fails — most common is `NO_SPEECH_DETECTED`, meaning the mic toggle is
OFF in Extended Controls.
