#!/bin/sh
# Copies the device to the MacBook that runs Live (ssh host "macbook", or HOST):
#   --release: the frozen device dist/Google Docs.amxd (tools/build-release.mjs)
#     as <User Library>/Presets/Audio Effects/Max Audio Effect/Google Docs.amxd;
#   without: a development build, the code in <User Library>/Google Docs/app/
#     {node,ui,max,package.json} and the device "Google Docs (dev).amxd" next
#     to the release, so it never replaces it;
#   both, with CLIENT=<client.json>: once, that OAuth client as
#     ~/Library/Application Support/ableton-google-docs/client.json (0600).
#     A development build has no client of its own and needs it; the release
#     has one when it was built with RELEASE_CLIENT (README, "Releases").
# The Google token is made on the MacBook at the first sign-in and never leaves it.
# Usage: [HOST=<ssh host>] [CLIENT=<client.json>] tools/deploy-macbook.sh [--release]
set -eu
HOST=${HOST:-macbook}
REMOTE_HOME=${REMOTE_HOME:-$(ssh "$HOST" 'echo "$HOME"')}
REMOTE_LIB=${REMOTE_LIB:-$REMOTE_HOME/Music/Ableton/User Library}
APP="$REMOTE_LIB/Google Docs/app"
DEVICES="$REMOTE_LIB/Presets/Audio Effects/Max Audio Effect"
SECRETS="$REMOTE_HOME/Library/Application Support/ableton-google-docs"
cd "$(dirname "$0")/.."

ssh "$HOST" "mkdir -p '$APP' '$DEVICES'"
if [ "${1:-}" = "--release" ]; then
  node tools/build-release.mjs
  ssh "$HOST" "cat > '$DEVICES/Google Docs.amxd'" < "dist/Google Docs.amxd"
  echo "frozen device copied to $HOST:$DEVICES/Google Docs.amxd"
else
  COPYFILE_DISABLE=1 tar -cf - node ui max package.json | ssh "$HOST" "tar -C '$APP' -xf -"
  mkdir -p scratch
  node tools/build-device.mjs scratch/macbook.amxd "$APP/node/main.js"
  ssh "$HOST" "cat > '$DEVICES/Google Docs (dev).amxd'" < scratch/macbook.amxd
  echo "development build copied to $HOST:$APP"
fi

if ssh "$HOST" "test -e '$SECRETS/client.json'"; then
  echo "client.json is already on $HOST"
elif [ -n "${CLIENT:-}" ]; then
  ssh "$HOST" "umask 077 && mkdir -p '$SECRETS' && cat > '$SECRETS/client.json'" < "$CLIENT"
  echo "copied the OAuth client to $HOST:$SECRETS/client.json"
fi
