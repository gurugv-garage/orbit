# orbit — Self-Update (OTA) design

> How the two field devices — the **node-dock app** (Android) and the
> **node-dock body** (ESP32) — update their own code without a cable. Both
> ride machinery orbit-station already has: one persistent WebSocket per peer,
> topic subscribe + directed push, and a versioned `hello` handshake.
>
> Decisions baked in (see decision log at the bottom):
> - **App** updates **silently** via device-owner `PackageInstaller` — zero taps,
>   the appliance updates itself.
> - **Artifacts** are **built on demand** by a station-side build hook, but the
>   station's serve/announce surface is identical whether the hook builds or a
>   human drops a file — so the control plane is never *welded* to the toolchain.
> - **ESP32 first**, then the station `ota` module, then app self-update.

---

## 0. Why this rides the station, not a new channel

orbit-station is already the single bridge both devices hold a socket to
(`/ws`, see `server/src/core/protocol.ts`). It already:

- knows each peer's `dock`, `role`, and version-bearing `hello`,
- fans out `event` frames to topic subscribers (and supports **directed** push,
  `to: peerId`, used today by the config module),
- pushes-on-change (config module pattern).

So OTA is **one more module + one more topic** (`ota`), mirroring `config`.
No new endpoint, no new transport, no second connection for a device to babysit.

```
            build hook (pio / gradle, or manual drop)
                        │  artifacts + version + sha256
                        ▼
        ┌────────────────────────────────────────────┐
        │  orbit-station :: ota module                │
        │  • artifact store (bin / apk + metadata)    │
        │  • REST: metadata + raw artifact download   │
        │  • announce: publish ota/available on change│
        │  • version compare on each hello            │
        └───────┬───────────────────────────┬─────────┘
   event ota/   │  (existing /ws)            │  event ota/
   available    ▼                            ▼  available
        ┌───────────────┐            ┌────────────────┐
        │ node-dock app │            │ node-dock body │
        │ (Android)     │            │ (ESP32 / IDF)  │
        │ PackageInst.  │            │ esp_https_ota  │
        │ silent (DO)   │            │ + A/B rollback │
        └───────────────┘            └────────────────┘
```

The artifact **bytes** download over plain REST (`GET …/firmware.bin`,
`GET …/app.apk`) — a WebSocket is the wrong place to stream a multi-MB blob.
The socket carries only the small **"version X is available at URL, sha256 Y"**
signal. Devices that were offline when the signal fired catch up via the
version compare baked into their `hello` (§3).

### 0.1 Bootstrap (cabled, once) vs. steady state (network, forever)

**Steady state is cableless.** Every *update* is over the network: the station
serves the artifact, the device pulls and self-applies. No USB, no `adb`, no
`pio run -t upload` in the normal loop.

There are exactly **two one-time bootstrap cables**, both at first
provisioning, neither part of the update loop:

| Device | The one bootstrap cable | Why it's unavoidable | After that |
|---|---|---|---|
| **ESP32 body** | first USB flash (`pio run -t upload`) | a chip with no OTA partitions can't receive its first OTA — the partition table that *enables* OTA ships in this flash | all updates network OTA; bad pushes self-revert (§4.3) |
| **App phone** | one `adb` session: install + `dpm set-device-owner` | silent install requires the device-owner grant, which is a one-time on-device authorization | all updates silent network install (§5) |

The app's cable is *only* for the **silent** path. If you accept a tap per
update, app bootstrap needs no cable at all (sideload the first APK any way you
like). The ESP32's first cable is genuinely unavoidable.

`adb install -r` (app) and `pio run -t upload` (body) also remain as
**break-glass** — recovery if a push is so broken even rollback can't save it.
Not part of the loop; the cable is the guarantee under the convenience.

### 0.2 Where the build runs — the "build box" coupling, stated plainly

Artifacts are **built on demand by the station host** (your call). That means
the station host must have the full toolchains: Android SDK + JDK + the release
keystore + `local.properties` (app), and PlatformIO (body). This **reverses**
the earlier "keep the toolchain off the control plane" lean — a deliberate
trade for one-click builds, fine while the station *is* your dev laptop.

It's a configuration, not a weld: the station's **serve + announce** REST
surface (§2.2) is identical whether the bytes came from the build hook or a
hand-dropped file. A toolchain-less host (a Pi, a cloud box) drops the artifact
+ `meta.json` into `var/ota/` and calls `POST …/announce` — same downstream,
no build box. So "build box" is the default wiring, not a permanent dependency.

---

## 1. Wire protocol additions

One new topic in `server/src/core/protocol.ts`:

```ts
export type Topic =
  | 'obs' | 'config' | 'bodylink' | 'mind' | 'station'
  | 'ota';        // ← new: update availability + (optional) progress
```

Message kinds on `ota`:

| Direction | kind | payload | meaning |
|---|---|---|---|
| station → peer | `available` | `{ target, build, version?, url, sha256, size }` | an update exists; pull it. `build`+`url`+`sha256` are load-bearing; `version` is just the station's label (informational — the device ignores it) |
| peer → station | `progress` | `{ target, phase, pct? }` | live telemetry → console progress bar |
| peer → station | `result` | `{ target, build, ok, error? }` | applied / failed (also confirmed by next `hello`/heartbeat `build`) |
| browser → station | (REST) | `POST /api/ota/:target/build` `{notes?}` · `/announce` | console trigger (§7); `notes` = release details recorded in meta |
| station → browser | `state` | `{ target, artifact, peers[] }` | console snapshot: artifact meta + per-device `build`/status |

`target` is `"body"` or `"app"`. `url` is absolute so a device needs no base-URL
config. `available` is sent **directed** (`to: peerId`) so each device only hears
about its own artifact — same `to:` mechanism the config module already uses.
`progress`/`result` are **broadcast on `ota`** (not directed) so the **browser
console** subscribing to `ota` sees every device's live status — that's what
drives the UI in §7.

**`phase` vocabulary** (one enum, both targets, so the console renders them
uniformly):

| phase | body (ESP32) | app (Android) |
|---|---|---|
| `building` | station-side `pio run` | station-side `gradle assembleRelease` |
| `downloading` | streaming `.bin` (`pct` = bytes) | downloading `.apk` (`pct` = bytes) |
| `verifying` | sha256 check | sha256 check |
| `applying` | writing slot / set boot | `PackageInstaller` commit |
| `rebooting` | reset into new slot | process replace + relaunch |
| `validating` | pending-verify: rejoin Wi-Fi + station | cold-start + station reconnect |
| `done` | `mark_app_valid` called | new `versionCode` confirmed |
| `rolledback` | bootloader reverted to last-good | (n/a — install is atomic) |
| `failed` | any error (`error` set) | any error (`error` set) |

`building` is emitted by the **station** (the build hook), the rest by the
**device** — but they share one stream/enum, so the console shows a single
continuous timeline from "build started" through "running on device."

The `hello` frame already exists; we add a `build` integer to it (and to every
heartbeat, §3) so the station can decide whether to emit `available` the moment
a peer connects or beats.

---

## 2. orbit-station :: `ota` module

New module under `server/src/modules/ota/`, same shape as `config`
(`name`, `topic`, `description`, `init(bus)`, REST routes under `/api/ota`).

### 2.1 Artifact store

A small on-disk store (a dir, e.g. `orbit-station/var/ota/`, gitignored):

```
var/ota/
  body/  firmware.bin  meta.json   # see §3.3 — { target, build, version, sha256, size, builtAt }
  app/   app.apk        meta.json
```

`meta.json` is the source of truth for "what's the latest"; the binary sits
next to it. Its `build` (monotonic integer) is the **only** field the OTA
comparator reads; `version` is the human label. Full scheme + how each target
derives them is **§3 (Versioning)** — the build hooks populate `meta.json` from
the artifact itself so it can never disagree with the binary.

### 2.2 REST surface (identical regardless of how bytes got there)

```
GET  /api/ota                       both targets' current meta (console view)
GET  /api/ota/:target/latest        meta.json for body|app
GET  /api/ota/:target/firmware.bin  raw body artifact            (target=body)
GET  /api/ota/:target/app.apk       raw app artifact             (target=app)
POST /api/ota/:target/build         run the build hook → produce a new artifact
POST /api/ota/:target/announce      re-emit ota/available to that target's peers
```

Raw downloads set `Content-Length` and stream from disk. The body `.bin`
download additionally tolerates HTTP range/no-cache the way `esp_https_ota`
expects (plain 200 with full body is fine for IDF).

### 2.3 Build hook (the on-demand build, decoupled)

`POST /api/ota/:target/build` invokes a **hook script**, not inline logic:

- `var/ota/build-body.sh`  → runs `pio run` in `node-dock/body-firmware/dock_body_v0`,
  copies `.pio/build/seeed_xiao_esp32s3/firmware.bin` into `var/ota/body/`,
  writes `meta.json` (version from the build, sha256, size).
- `var/ota/build-app.sh`   → runs `./gradlew :app:assembleRelease` in
  `node-dock/app`, copies the signed APK into `var/ota/app/`, writes `meta.json`.

Why a hook and not inline: the station's **serve + announce** surface is the
contract; *how the bytes appear* is swappable. On your dev laptop the hook
shells out to the real toolchains. On a minimal host (a Pi, a cloud box) the
"hook" is just you dropping a file + meta into the dir and calling
`POST …/announce`. **The control plane never hard-depends on PlatformIO, the
Android SDK, or your signing keys** — that coupling lives entirely in the
optional hook script. This is the one real trade-off of "build on demand," and
this is how we keep it from metastasizing into "the station must be my dev box
forever." (Signing keys for `assembleRelease` stay in the same untracked
`local.properties` the build already uses — never in the station, never
committed.)

After a successful build (or manual drop + announce), the module:
1. updates `meta.json`,
2. emits `ota/available` (directed) to every connected peer of that target,
3. logs it for the console.

### 2.4 Builds run in a tmux session — attachable + debuggable

The build hook is **not** a detached child of the Node process (a black box when
`pio`/`gradle` hangs or fails). The module launches it in a **named tmux
session** so a human can attach to the live toolchain output and even drive it:

```
tmux new-session -d -s ota-build-body \
  'bash var/ota/build-body.sh 2>&1 | tee var/ota/body/build-<build>.log; \
   echo "[exit $?] — session stays open for inspection"; exec bash'
```

- **Session name** is deterministic per target: `ota-build-body` /
  `ota-build-app` (only one build per target at a time; a second trigger while
  one runs returns "build already running" rather than racing).
- **`tee` to a per-build log** (`var/ota/<target>/build-<build>.log`) so the
  output is both live (attach) and persisted (after the session is gone).
- **Session lingers on exit** (`exec bash`) — a *failed* build leaves you a shell
  sitting in the build dir with the error on screen; `tmux attach -t
  ota-build-body` drops you right into it to re-run `pio run` by hand, inspect
  `.pio/`, fix, retry. No re-deriving where it broke.
- The Node module **watches** the session (poll `tmux has-session` + tail the
  log) and translates it to the wire: `progress {phase:"building"}` while it
  runs, then `result`/`failed` with the tail of the log on exit. It never blocks
  on the build.

**The console surfaces all of this** (§7.4) so you don't have to hunt: the exact
attach command, the session name, the live/last log path, and the running/last
exit state are shown right on the OTA card. One click to copy
`tmux attach -t ota-build-body`.

---

## 3. Versioning — build-only on the wire, metadata on the station

Every OTA decision reduces to one comparison: *is the station's artifact newer
than what the device is running?* The answer needs exactly **one monotonic
integer per device — the `build`**. Nothing else belongs on the wire.

### 3.0 One number on the wire: `build`

A device reports a single `build` integer — its OTA identity AND the gate:

| | `build` (the only version a device sends) |
|---|---|
| **What** | a single monotonic integer |
| **Job** | the *only* thing the comparator reads: `station.build > device.build` → offer |
| **App** | `versionCode` (Android's native update integer) |
| **Body** | `BL_FW_BUILD` (a `#define` in `include/version.h`) |

That's the whole comparison. No SemVer parsing, ever — that's where OTA systems
get subtle bugs (pre-release tags, `1.10` vs `1.9`). The integer sidesteps all
of it. A device only ever moves *toward* a **strictly greater** build: never
sideways, never down. The firmware/app each refuse a non-greater offer locally,
and on the app side **Android independently refuses** an APK whose `versionCode`
≤ installed — belt and suspenders on the one rule that matters.

**Human labels do NOT go on the wire.** "What does build 7 mean" (a SemVer
label, release notes, build time) is **station-owned metadata** (§3.2), not
something a device carries around. This keeps the device side trivial and makes
the station the single place that describes a release.

### 3.1 Where `build` comes from (per target)

- **App**: `versionCode` in [app/build.gradle.kts](../node-dock/app/app/build.gradle.kts).
  Monotonic integer, **+1 every release that ships an APK**. The build hook
  (`build-app.sh`) reads it straight out of the built APK (`aapt dump badging`)
  into `meta.json` — so the recorded build can't disagree with the binary.
  (`versionName` still exists — Android requires it and shows it in Settings —
  but it's *not* sent on the OTA wire; the hook records it as station metadata.)
- **Body**: `BL_FW_BUILD` in
  [include/version.h](../node-dock/body-firmware/dock_body_v0/include/version.h).
  `#define`, **+1 per firmware release**. `hello` + every heartbeat carry it;
  `build-body.sh` reads it into `meta.json`. (`BL_FW_VERSION` also lives there,
  but only because the pre-OTA BodyLink *profile* advertises an `fw_version`
  string — it is NOT on the OTA wire and NOT pinned into the image header.)

The device reports `build` in **`hello` AND every heartbeat** (§ heartbeat,
docs) — so the station's view self-heals after an OTA reboot without waiting for
a full reconnect.

### 3.2 Station-owned build metadata (`meta.json`)

The station is the keeper of what a build *means*. `meta.json` per target:

```jsonc
// var/ota/<target>/meta.json
{
  "target":  "body",          // or "app"
  "build":   7,               // ← the gate; the ONLY field compared
  "version": "0.3.1",         // station metadata: human label (optional)
  "notes":   "Fix neck drift; faster boot.",  // release details, entered at build time
  "sha256":  "…",             // integrity — checked on-device before boot/install
  "size":    1048576,
  "builtAt": "2026-06-09T…"   // build time
}
```

- **`build`** is the gate. Everything else is **metadata the station owns** and
  the device never sends: `version` (label), `notes` (release details typed in
  the console at build time, §7), `builtAt` (build time), `sha256`+`size`
  (integrity/provenance).
- The build hooks populate `build`/`version` *from the artifact itself* and the
  station recomputes `sha256`/`size`/`builtAt` from the bytes — so `meta.json`
  can't lie about what the binary is. `notes` come from the console's build
  request (the one human-authored field).
- **Amnesia note:** if a device reports a `build` the station has no `meta.json`
  for (an old build, a foreign build), the console simply shows "build N" with
  no label. Acceptable: N is still readable, and the gate still works. Devices
  staying self-describing was the only thing the old wire-string bought, and
  it's not worth the redundancy.

### 3.3 Negotiation: the symmetric trigger

A device offline when a new artifact landed must still update, so the gate runs
on **every `hello`** (and heartbeat), not only on artifact change:

- `hello`/heartbeat carry the device's `build`.
- The station compares `meta.json.build` against the peer's `build`. If
  `station.build > device.build`, it sends a directed `ota/available`.

Two symmetric triggers, same comparator:

- **new artifact while peer online** → push `available` to behind peers,
- **peer (re)appears or heartbeats while behind** → push `available` to it.

The comparator refuses non-greater `build`; Android enforces it again at
install. No accidental downgrade, no re-push loop.

### 3.4 Bumping checklist (per release)

- **App**: `versionCode +1` (required) in
  [app/build.gradle.kts](../node-dock/app/app/build.gradle.kts). Optionally bump
  `versionName` for the label.
- **Body**: `BL_FW_BUILD +1` (required) in
  [include/version.h](../node-dock/body-firmware/dock_body_v0/include/version.h).
- **Release notes** are entered in the **console** at Build-&-Announce time
  (§7) — not in source. The station records them in `meta.json`.
- Forgetting the integer bump = the station won't offer the build (gate sees
  "not newer"). That's the *safe* failure — it under-updates, never mis-updates.

---

## 4. node-dock body (ESP32) — `esp_https_ota` + A/B rollback

This half is low-risk: ESP-IDF ships the OTA machinery and the *rollback* that
makes flashing a glued-in, headless body safe.

### 4.1 Partition table (one-time firmware change)

Today there are no OTA partitions in `sdkconfig.defaults` (single-app default).
Switch to a dual-slot custom table — the S3's 8 MB flash has ample room:

```
# partitions.csv
# name,     type, subtype, offset,   size
nvs,        data, nvs,     0x9000,   0x6000
otadata,    data, ota,     0xf000,   0x2000
phy_init,   data, phy,     0x11000,  0x1000
ota_0,      app,  ota_0,   0x20000,  0x300000
ota_1,      app,  ota_1,   0x320000, 0x300000
```

In `sdkconfig.defaults`:

```
CONFIG_PARTITION_TABLE_CUSTOM=y
CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"
CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
CONFIG_APP_ROLLBACK_ENABLE=y
```

(PlatformIO: `board_build.partitions = partitions.csv` in `platformio.ini`.)

### 4.2 Trigger — one new branch in `station_link.c`

`handle_event()` already dispatches station events by `kind` (today only
`command`). Add:

```c
// in handle_event(), alongside the existing command branch:
if (strcmp(topic->valuestring, "ota") == 0 &&
    strcmp(kind->valuestring, "available") == 0) {
    cJSON *payload = cJSON_GetObjectItemCaseSensitive(f, "payload");
    // hand the offer { build, url, sha256 } to the OTA task. station_ota_begin
    // parses build/url/sha256 itself, ignores non-newer builds, and runs the
    // OTA on its OWN FreeRTOS task — never blocks this WS event callback.
    if (payload) station_ota_begin(payload);
    return;
}
```

`station_ota_begin` runs `esp_https_ota` on its own task: it streams the URL
into the inactive slot, verifies the sha256, sets the boot partition, and
reboots. New `station_ota.c` / `.h` next to `station_link.c`.

### 4.3 Rollback = the safety net

With `CONFIG_APP_ROLLBACK_ENABLE`, the freshly-flashed image boots in
**pending-verify**. The firmware calls
`esp_ota_mark_app_valid_cancel_rollback()` **only after** it has rejoined Wi-Fi
*and* reconnected to the station (i.e. proven the new build actually works).
If the new image bricks the join, the bootloader auto-reverts to the last-good
slot on the next reset. This is the single most important piece — it's what
makes pushing firmware to a body on your desk a non-event instead of a
soldering-iron recovery.

`hello` reports the running version (§3); the station sees the rolled-back
version and simply won't re-offer the bad one until a newer artifact exists.

### 4.4 Build in `hello` + heartbeat

`station_link.c` reports a single OTA version — `build` = `BL_FW_BUILD`
(`include/version.h`, §3.1) — in both `hello` and every heartbeat, so the
station's view self-heals after an OTA reboot without a full reconnect. That's
the only version on the wire; the station compares `hello.build` /
`heartbeat.build` against `var/ota/body/meta.json.build` (§3.3) and maps
build→label/notes itself. (`BL_FW_VERSION` stays in the header for the
pre-OTA BodyLink profile's `fw_version`, not the OTA path.)

---

## 5. node-dock app (Android) — silent device-owner install

No Play Store (sideloaded, GrapheneOS/Lineage target). The app self-hosts its
APK and installs it itself.

### 5.1 Silent install via device-owner

The dock phone is provisioned **once** as device-owner (the appliance model the
plan already assumes):

```bash
# one-time, on a freshly-set-up / factory-reset phone with no accounts:
adb shell dpm set-device-owner dev.orbit.dock/.DeviceAdminReceiver
```

A device-owner app may call `PackageInstaller` with no per-install user prompt —
**silent, zero-tap updates**. (Without device-owner, the same code path still
works but pops the system "update this app?" dialog each time; that's the
fallback if provisioning isn't done, not the target.)

### 5.2 Update flow (Kotlin, in `:app`)

1. **Subscribe** to `ota` on the station socket; **register interest** the same
   way components register config interest today.
2. On `ota/available` (or on a periodic check), compare payload `version`
   against `BuildConfig.VERSION_CODE`. If newer:
3. **Download** `url` to app-private storage; verify `sha256`.
4. **Install** via `PackageInstaller` session: open session, `write()` the APK,
   `commit()`. As device-owner this applies silently; the app process is
   replaced and relaunched (the foreground mic/cam service restarts clean — the
   app already handles cold start).
5. **Report** `ota/result` on next `hello` (new `versionCode` is itself the proof).

### 5.3 Scheduling

Default to **idle-window** updates (e.g. only act on `available` between 3–5am,
or when no active conversation / face present — the app already tracks presence).
An always-on appliance should not restart mid-interaction. Config knob
(`otaWindow`) via the existing config registry.

---

## 6. Security (don't skip — these pull executable code over the wire)

- **Same-LAN assumption today.** Both devices already trust the station on the
  local network. OTA does not widen that trust *if* the station stays LAN-only.
- **sha256 on every artifact**, checked by the device before it boots/installs
  the image. Non-negotiable — it's the integrity floor.
- **App: signature continuity.** Android already enforces that an update APK is
  signed with the *same key* as the installed app, or the install is rejected.
  So a rogue station cannot push a different-signer APK over your dock app. Keep
  the signing key off the station (it lives in the build hook's `local.properties`).
- **Firmware: enable secure download / image signing when the station leaves the
  LAN.** For LAN-only, sha256 + the rollback gate is the pragmatic floor; if the
  station ever gets a public URL, turn on IDF Secure Boot v2 + signed OTA images
  (`CONFIG_SECURE_SIGNED_APPS…`) before that day, not after.
- **HTTPS to the station** is optional on a trusted LAN (sha256 covers integrity,
  not confidentiality); required the moment the path crosses an untrusted network.

---

## 7. Console — trigger + watch from the orbit-station UI

OTA gets its own tab in the web console (`web/src/modules/Ota.tsx`), registered
in [App.tsx](../orbit-station/web/src/App.tsx) next to Config/BodyLink. It uses
the **exact pattern every other module uses**: `api.get`/`api.post` for REST,
`useStationEvents('ota', …)` for the live stream. No new frontend machinery.

### 7.1 What the operator sees — one card per target (body, app)

```
┌─ OTA · body (ESP32) ──────────────────────────────────┐
│ artifact   build 7   v0.3.1   1.0 MB   built 14:22     │
│ device     build 6   v0.3.0   ● online   ⚠ behind      │
│                                                        │
│ [ Build & Announce ]   [ Re-announce ]                 │
│                                                        │
│ ▸ validating ████████████░░░░  rejoin Wi-Fi + station  │
│   building→download→verify→apply→reboot→validate→done  │
└────────────────────────────────────────────────────────┘
```

Each card shows, live:
- **Artifact row** — the station's current `meta.json` (`build`, `version`,
  size, builtAt). The thing a trigger would push.
- **Device row(s)** — per connected peer of that target: its running `build` /
  `version` (from `hello`), online dot, and a computed badge:
  **up-to-date** (build == artifact) · **behind** (device < artifact) ·
  **ahead** (device > artifact — dev build; never auto-touched).
- **Live progress** — the §1 `phase` timeline with a bar; the active phase
  highlighted, `error` shown inline if `failed`, a distinct red state if
  `rolledback`. Driven entirely by the broadcast `progress`/`result` events.

### 7.2 What the operator can trigger (buttons → REST)

| Button | Calls | Effect |
|---|---|---|
| **Build & Announce** | `POST /api/ota/:target/build` | runs the build hook (emits `building` progress live), writes `meta.json`, then auto-`announce` to behind peers |
| **Re-announce** | `POST /api/ota/:target/announce` | re-emit `available` to that target's peers without rebuilding (e.g. a device that missed it / just reconnected) |
| **Update this device** (per-peer) | `POST /api/ota/:target/announce?to=<peerId>` | force-offer the current artifact to one specific peer |

No "upload artifact" button needed in the **build-box** model (§2.3): the
station *is* the build box, so the artifact is produced in-place by the hook.
(The manual-drop fallback path is CLI/file-drop + Re-announce — kept for a
toolchain-less host, not surfaced as a primary button.)

### 7.3 How the console stays live (no polling)

- On mount: `GET /api/ota` → seed both cards with current artifact meta + the
  station's view of each peer's last-known `build`/`version`/online.
- Then `useStationEvents('ota', …)` handles, with **zero polling**:
  - `state` → refresh a card's artifact/peer snapshot (sent on build done,
    on a peer's `hello`, on connect/disconnect),
  - `progress` → advance that target's phase bar,
  - `result` → settle to `done` / `failed` / `rolledback`.
- Peer online/version also rides the existing **`station`/`docks`** presence the
  console already shows — OTA just adds the build-comparison badge on top.

So a full operator loop is: open OTA tab → see "body: device build 6, artifact
build 7, ⚠ behind" → hit **Build & Announce** (or **Re-announce** if already
built) → watch building→download→verify→apply→reboot→validate→**done** stream by
→ device row flips to **up-to-date**. If the firmware can't rejoin, the bar lands
on **rolledback** in red and the device row stays at build 6 — the failure is
visible, not silent.

### 7.4 Build session — attach & debug from the card

When a build is triggered, the card grows a **Build** strip fed by §2.4:

```
┌─ OTA · body (ESP32) ──────────────────────────────────┐
│ …artifact / device rows as above…                     │
│                                                        │
│ build  ● running   session ota-build-body              │
│        $ tmux attach -t ota-build-body        [copy]   │
│        log var/ota/body/build-7.log           [tail ▸] │
│        ── live tail ───────────────────────────────────│
│        Linking .pio/build/seeed_xiao_esp32s3/firmware… │
└────────────────────────────────────────────────────────┘
```

The card shows, from the module's view of the tmux session:
- **state** — `running` / `exited 0` / `exited <n>` (failed),
- **session name** + a one-click-copy `tmux attach -t …` so you log in to the
  live toolchain and debug/re-run by hand,
- **log path** + an inline **tail** (the module streams the last N log lines as
  `progress` so you watch without leaving the browser),
- on failure: the strip turns red and **keeps the attach command** — the session
  lingered (§2.4), so attaching drops you straight into the broken build dir.

So "trigger from the console and see status" includes the *build's* status and a
direct door into it — not just the device-side phases. A failing `pio`/`gradle`
is one copy-paste away from a live shell, with the full log already on disk.

---

## 8. Build / sequencing plan

1. **ESP32 OTA** (lowest risk, hardest device to physically reach):
   partition table + `sdkconfig` rollback flags → `station_ota.c` task →
   `handle_event` branch → `version` in `hello`. Test against a hand-served
   `firmware.bin` before the station module exists (`python -m http.server`).
2. **Station `ota` module**: artifact store + REST + `available`/version-compare,
   following the `config` module shape. Manual drop first; build hook second.
3. **Console tab** (`Ota.tsx`, §7): cards + trigger buttons + live phase bar off
   the `ota` broadcast. Lands as soon as the module emits `state`/`progress` —
   gives you the trigger+watch loop before the app half exists (body OTA is
   already drivable from it).
4. **App self-update**: `PackageInstaller` path with the tap-confirm fallback
   working first, then device-owner provisioning for silent. `adb install -r`
   remains the manual escape hatch throughout.
5. **Build hooks** (`build-body.sh`, `build-app.sh`) + `POST …/build` last —
   convenience over a surface that already works by manual drop.

Keep `adb install -r` (app) and `pio run -t upload` (body) as the always-there
fallbacks; OTA is the convenience, the cable is the guarantee.

---

## Decision log

- **OTA rides the station, not a new service.** Both devices already hold one
  persistent socket with subscribe + directed push + a versioned handshake.
  Reusing it means no new transport, no second connection to babysit. The topic
  `ota` mirrors `config`.
- **App: silent device-owner install** (not tap-confirm, not F-Droid). node-dock
  is an unattended appliance on GrapheneOS/Lineage; the plan already assumes
  controlled provisioning. Tap-confirm is the no-provisioning fallback, not the
  target. F-Droid was rejected: another app in the loop, and it breaks "the dock
  app manages itself."
- **Artifacts built on demand — but behind a swappable hook.** The station's
  serve+announce REST surface is the contract; the build hook is optional and
  the only thing that touches PlatformIO / the Android SDK / signing keys. This
  buys on-demand convenience now without welding the control plane to a full dev
  box — the station can later run on a Pi or cloud host with the manual-drop
  path unchanged. This is the one real trade-off of "build on demand," made
  explicit so it doesn't metastasize.
- **ESP32 first.** Rollback makes firmware flashing safe, and the body is the
  hardest device to physically reach once it's in its shell — so it's the one
  that most needs OTA and the one safest to start with.
- **A/B + rollback is the firmware safety floor.** New image self-validates only
  after it rejoins Wi-Fi *and* the station; otherwise the bootloader reverts.
  No soldering-iron recovery for a bad push.
- **sha256 everywhere; signing when off-LAN.** Integrity floor for the LAN model;
  IDF Secure Boot (firmware) + Android signature-continuity (app, automatic) are
  the upgrades for the day the station gets a public URL.
- **Triggerable + observable from the console.** OTA gets a console tab (§7) with
  per-target cards: current artifact vs. each device's running version (with an
  up-to-date / behind badge), trigger buttons (Build & Announce, Re-announce,
  per-device update), and a live phase bar off the broadcast `progress`/`result`
  stream. Operator loop is open-tab → trigger → watch → device flips up-to-date,
  with rollback shown in red — no CLI for the happy path.
- **Builds run in a named tmux session, not a detached child.** A build
  (`pio`/`gradle`) is attachable (`tmux attach -t ota-build-{body,app}`) and its
  session lingers on failure so you can log in, inspect, and re-run by hand. The
  console surfaces the session name, attach command, log path, and a live tail
  (§2.4 + §7.4). A black-box build that silently hangs was the failure mode this
  avoids — the build is as observable and debuggable as the device-side flow.
