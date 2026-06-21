# Orbit app (`dev.orbit.dock`) — native crash in WebRTC audio capture

## Summary
The app is crashing with a **native SIGSEGV (null-pointer deref)** on the **`AudioRecordThread`**, inside the bundled WebRTC lib (`libjingle_peerconnection_so.so`). The audio-record thread calls `nativeDataIsRecorded(...)`, which `memcpy`s a captured mic buffer into the native side — and the native destination/source pointer is **null** (`x1 = 0x0000000000000000`). This is a classic **use-after-free / teardown race**: the `AudioRecord` capture thread is still delivering buffers **after** the native PeerConnection / audio device module it writes into has been disposed.

It is **not** a Kotlin/Java exception and **not** the conversation/session state machine throwing — it's a native teardown race in the audio/WebRTC layer.

## Reproduction signature
Crashed **4 times today (2026-06-20)**, all identical:

| Time (IST) | PID | Uptime before crash |
|---|---|---|
| 18:04:23 | 29908 | ~63 min |
| 18:26:06 | 29909 | ~85 min |
| 18:38:42 | 7732 | **~6 min** |
| 18:39:17 | 29911 | ~98 min |

The 6-min vs ~90-min spread implies it triggers on an **event (stream stop/restart / re-listen)**, not a fixed timer.

## Proof (crash backtrace, from `adb logcat -b crash`)
```
F/libc    : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
            in tid 5177 (AudioRecordJava), pid 29908 (dev.orbit.dock)
F/DEBUG   : Cause: null pointer dereference
F/DEBUG   :     x0  b40000700fa91980   x1  0000000000000000   x2  0000000000000140   <-- x1 (src/dst ptr) = NULL, x2 = 0x140 bytes
F/DEBUG   : backtrace:
  #00 pc ...0892d8  libc.so (__memcpy+232)
  #01 pc ...6552c8  base.apk!libjingle_peerconnection_so.so
  #02 pc ...6563d0  base.apk!libjingle_peerconnection_so.so
  #03 pc ...2c2100  libart.so (art_quick_generic_jni_trampoline+144)
  ...
  #09 pc ...1dbd30  org.webrtc.audio.WebRtcAudioRecord.-$$Nest$mnativeDataIsRecorded
  #13 pc ...270441c  org.webrtc.audio.WebRtcAudioRecord$AudioRecordThread.run+3068
  ...
  #24 pc ...4bdc28  libart.so (art::Thread::CreateCallback)
  #25 pc ...f57c8   libc.so (__pthread_start)
```

Key frames, top → bottom:
- `__memcpy` faulting on a null pointer (`x1 = 0x0`, copying `0x140` bytes)
- inside `libjingle_peerconnection_so.so` (WebRTC native)
- entered via JNI from `WebRtcAudioRecord.nativeDataIsRecorded`
- on `WebRtcAudioRecord$AudioRecordThread.run` (the dedicated `AudioRecordJava` thread)

## What to look at in the code
The bug is a lifecycle ordering issue between mic capture and the WebRTC native object:

- **The fix invariant:** the `AudioRecord` capture thread must be **stopped and joined BEFORE** the `PeerConnection` / `AudioDeviceModule` (the native object `nativeDataIsRecorded` writes into) is disposed/freed. Right now the thread is still running and pushing a buffer after that native object is gone.
- **Where to hunt:** the media/WebRTC stream **teardown + restart** path, and how it interleaves with **listening start/stop**. On the `always-on-stt` branch the mic/WebRTC capture is started/stopped (or kept alive across session boundaries) differently — likely surfaces:
  - `node-dock/app/app/src/main/kotlin/dev/orbit/dock/ui/face/PerceptionWiring.kt` (modified on branch — perception/listening wiring)
  - `node-dock/app/app/src/main/kotlin/dev/orbit/dock/agent/RemoteBrain.kt` (modified on branch — drives re-listen)
  - whatever owns the WebRTC `PeerConnection` / `AudioDeviceModule` / media stream lifecycle (the SFU client that streams A/V to the station `media` module).
- **Likely fix shapes:** ensure `audioRecord.stop()` + thread join completes before `peerConnection.dispose()` / ADM release; guard `nativeDataIsRecorded` against a disposed native handle; or don't dispose the audio device module on a re-listen if capture is meant to stay alive.

## Fix applied (2026-06-20)

**Root cause located:** `MediaStreamer.stop()` (called by `restart()` on ICE
failure/reconnect — the "stream restart" event) disposed the `audioSource` +
`PeerConnection` (the native sink `nativeDataIsRecorded` writes into) while the
**shared, always-on `WebRtcAudio` ADM kept its `AudioRecord` capture thread
running**. The next 10 ms buffer memcpy'd into the freed sink → SIGSEGV.

**Fix:** bracket the native teardown with a capture pause:
- `WebRtcAudio.pauseRecording()` / `resumeRecording()` (→ ADM
  `requestStopRecording()` / `requestStartRecording()`).
- `MediaStreamer.stop()` calls `pauseRecording()` BEFORE `pc.close()` /
  `audioSource.dispose()`; `start()` calls `resumeRecording()` after rebuilding the
  tracks. So during disposal the capture thread is stopped — no in-flight buffer.
- **Why this is sufficient:** WebRTC's `WebRtcAudioRecord.stopRecording()` JOINs
  the `AudioRecordThread` (it has an `AUDIO_RECORD_THREAD_JOIN_TIMEOUT_MS`), so
  `requestStopRecording()` returns only after the thread is stopped — guaranteeing
  no buffer is delivered into the about-to-be-freed sink.

**Residual uncertainty (honest):** the crash is intermittent + event-triggered, so
I couldn't reproduce it on demand to *prove* the fix end-to-end yet. A second
possible source exists: the `TtsAecLoopback` (added for A1 AEC) creates its OWN
sender ADM/factory; if its teardown ever races, a similar crash could surface
there. The loopback currently has no teardown path (it persists for the app
lifetime), so it shouldn't race today — but if the crash recurs after this fix,
that's the next place to look. Watch `adb logcat -b crash` over a long session +
several reconnects.

## How to reproduce / capture more
```bash
adb logcat -b crash -d -v time            # the tombstones above
adb logcat -b main  -d -v time | grep -iE 'dev.orbit.dock|webrtc|AudioRecord|PeerConnection'
# ^ run around a crash timestamp to see whether a session-end / re-listen / stream-restart fired just before
```
