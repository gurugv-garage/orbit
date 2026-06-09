#!/usr/bin/env bash
# OTA build hook — node-dock app (Android). docs/OTA.md §2.3.
#
# Runs in a tmux session (`tmux attach -t ota-build-app` to watch/debug).
# Builds a SIGNED release APK, copies it into the station's artifact store, and
# writes built.json {build, version} where build = versionCode (the gate
# Android itself enforces) and version = versionName. Both come straight out of
# the built APK via aapt so the recorded version matches the actual artifact.
#
# Signing: the release signingConfig reads the keystore from local.properties
# (RELEASE_STORE_FILE/STORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD) — see gen-keystore.sh
# and build.gradle.kts. An unsigned APK can't be installed as an OTA update, so
# this hook fails loudly if signing isn't configured.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/node-dock/app"
OUT_DIR="$ROOT/orbit-station/var/ota/app"

echo "== ota build: app =="
echo "app:        $APP_DIR"

if [[ ! -f "$APP_DIR/local.properties" ]]; then
  echo "!! $APP_DIR/local.properties missing (SDK path + signing keystore)" >&2
  exit 2
fi
if ! grep -q '^RELEASE_STORE_FILE=' "$APP_DIR/local.properties"; then
  echo "!! release signing not configured in local.properties." >&2
  echo "   run: orbit-station/scripts/gen-keystore.sh   (docs/OTA.md §5.1)" >&2
  exit 2
fi

echo "== gradle assembleRelease =="
( cd "$APP_DIR" && ./gradlew :app:assembleRelease )

APK="$(find "$APP_DIR/app/build/outputs/apk/release" -name '*.apk' | head -1)"
if [[ -z "$APK" || ! -f "$APK" ]]; then
  echo "!! release APK not found under app/build/outputs/apk/release" >&2
  exit 3
fi
echo "apk:        $APK"

# Pull versionCode/versionName from the built APK (authoritative, not the source).
AAPT="$(find "${ANDROID_HOME:-$HOME/Library/Android/sdk}/build-tools" -name aapt 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$AAPT" ]]; then
  BADGING="$("$AAPT" dump badging "$APK")"
  BUILD="$(sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p" <<<"$BADGING" | head -1)"
  VERSION="$(sed -nE "s/.*versionName='([^']+)'.*/\1/p" <<<"$BADGING" | head -1)"
fi
# Fallback: parse build.gradle.kts if aapt unavailable.
if [[ -z "${BUILD:-}" ]]; then
  GRADLE="$APP_DIR/app/build.gradle.kts"
  BUILD="$(grep -E 'versionCode' "$GRADLE" | grep -oE '[0-9]+' | head -1)"
  VERSION="$(grep -E 'versionName' "$GRADLE" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)"
fi
if [[ -z "${BUILD:-}" || -z "${VERSION:-}" ]]; then
  echo "!! could not determine versionCode/versionName" >&2
  exit 4
fi
echo "build:      $BUILD (versionCode)"
echo "version:    $VERSION (versionName)"

mkdir -p "$OUT_DIR"
cp "$APK" "$OUT_DIR/app.apk"
cat > "$OUT_DIR/built.json" <<EOF
{ "build": $BUILD, "version": "$VERSION" }
EOF

echo "== done: app.apk ($(wc -c < "$OUT_DIR/app.apk") bytes), versionCode $BUILD =="
