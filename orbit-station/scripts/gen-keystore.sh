#!/usr/bin/env bash
# Generate the node-dock app's RELEASE signing keystore. docs/OTA.md §5.1.
#
# OTA needs a STABLE signing key: an update APK must be signed with the same key
# as the installed app (Android enforces this), and silent device-owner installs
# need a real identity (not the throwaway debug key). Run this ONCE; the keystore
# lives outside the repo and its path + passwords go in local.properties
# (gitignored) — never committed.
#
# Re-running refuses to clobber an existing keystore: losing it means you can
# never OTA-update an installed app again (you'd have to uninstall + reinstall).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/node-dock/app"
# Default keystore location: alongside local.properties, OUTSIDE git (app/ has
# its own .gitignore; we also keep it ignored — see check below).
KEYSTORE="${KEYSTORE:-$APP_DIR/dock-release.jks}"
ALIAS="${ALIAS:-dock}"

echo "== node-dock release keystore =="
echo "keystore: $KEYSTORE"

if [[ -f "$KEYSTORE" ]]; then
  echo "!! $KEYSTORE already exists — refusing to overwrite." >&2
  echo "   (Losing/replacing it means installed apps can never OTA-update again.)" >&2
  echo "   Delete it by hand if you really mean to start over." >&2
  exit 1
fi

command -v keytool >/dev/null || { echo "!! keytool not found (install a JDK)" >&2; exit 2; }

# Passwords: from env if provided (CI), else prompt. Store + key use one pass.
if [[ -z "${STORE_PASS:-}" ]]; then
  read -r -s -p "New keystore password (min 6 chars): " STORE_PASS; echo
  read -r -s -p "Confirm password: " STORE_PASS2; echo
  [[ "$STORE_PASS" == "$STORE_PASS2" ]] || { echo "!! passwords don't match" >&2; exit 3; }
fi
KEY_PASS="${KEY_PASS:-$STORE_PASS}"

keytool -genkeypair -v \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
  -dname "CN=orbit node-dock, OU=orbit, O=orbit, L=, ST=, C=US"

# Make sure the keystore is gitignored (defence-in-depth; never commit a key).
GI="$APP_DIR/.gitignore"
if [[ -f "$GI" ]] && ! grep -qE '^\*\.jks$|^dock-release\.jks$' "$GI"; then
  printf '\n# OTA release signing keystore — NEVER commit\n*.jks\n' >> "$GI"
  echo "added *.jks to $GI"
fi

cat <<EOF

== keystore created ==
Add these lines to $APP_DIR/local.properties (gitignored):

  RELEASE_STORE_FILE=$KEYSTORE
  RELEASE_STORE_PASSWORD=<the password you just set>
  RELEASE_KEY_ALIAS=$ALIAS
  RELEASE_KEY_PASSWORD=<same password>

Then 'orbit-station/scripts/build-app.sh' (and bootstrap-app.sh) will produce a
signed, OTA-installable release APK. See docs/OTA.md §5.1.
EOF
