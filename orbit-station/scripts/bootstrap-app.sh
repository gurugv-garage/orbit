#!/usr/bin/env bash
# First-time CABLED bootstrap of the dock app (Android phone). docs/OTA.md §0.1 + §5.1.
#
# One-time USB session that sets the phone up for SILENT network OTA afterward:
#   1. build a SIGNED release APK (needs the keystore — run gen-keystore.sh first)
#   2. adb install it
#   3. make the app DEVICE OWNER (unlocks silent PackageInstaller updates)
#   4. verify the app is installed
#
# After this, the app self-updates over the network with no tap (Build & Announce
# from the console). Re-run safely: install -r reinstalls; device-owner is a
# one-time grant that no-ops if already set.
#
# DEVICE-OWNER REQUIREMENT: the phone must have NO added accounts (fresh / factory
# reset). `dpm set-device-owner` fails otherwise — that's an Android rule, not us.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/node-dock/app"
PKG="dev.orbit.dock"
ADMIN="$PKG/.ota.DockDeviceAdminReceiver"

echo "== bootstrap: dock app (Android) — CABLED first install =="
command -v adb >/dev/null || { echo "!! adb not found (install platform-tools)" >&2; exit 2; }

# 0. A device must be connected.
if ! adb get-state >/dev/null 2>&1; then
  echo "!! no device via adb. Plug in the phone + enable USB debugging." >&2
  exit 2
fi
echo "device: $(adb shell getprop ro.product.model | tr -d '\r') (android $(adb shell getprop ro.build.version.release | tr -d '\r'))"

# 1. Signed release build (build-app.sh fails loudly if signing isn't configured).
echo "== building signed release APK =="
bash "$ROOT/orbit-station/scripts/build-app.sh"
APK="$(find "$APP_DIR/app/build/outputs/apk/release" -name '*.apk' | head -1)"
[[ -f "$APK" ]] || { echo "!! release APK not found" >&2; exit 3; }

# 2. Install (replace existing).
echo "== adb install =="
adb install -r "$APK"

# 3. Device owner — the one-time grant that enables SILENT OTA installs.
if adb shell dpm list-owners 2>/dev/null | grep -q "$PKG"; then
  echo "== already device owner — silent OTA already enabled =="
else
  echo "== setting device owner ($ADMIN) =="
  if adb shell dpm set-device-owner "$ADMIN" 2>&1 | tee /dev/stderr | grep -q "Success"; then
    echo "== ✓ device owner set — app can now install OTA updates silently =="
  else
    echo "!! could not set device owner." >&2
    echo "   Most common cause: the phone has accounts added. Device-owner needs a" >&2
    echo "   fresh / factory-reset phone with NO accounts. Remove accounts (or factory" >&2
    echo "   reset) and re-run. Without this the app still OTA-updates, but shows a" >&2
    echo "   per-install confirm dialog instead of installing silently (docs/OTA.md §5.1)." >&2
  fi
fi

# 4. Verify install.
if adb shell pm list packages | grep -q "$PKG"; then
  VC="$(adb shell dumpsys package "$PKG" | grep -m1 versionCode | tr -d ' \r')"
  echo "== ✓ $PKG installed ($VC). Future updates are network OTA. =="
else
  echo "!! $PKG not found after install." >&2; exit 4
fi
