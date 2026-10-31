#!/bin/sh
# Dev only: loads the device in Live on this Mac without clicks and checks in
# the device log: the page round trip, the stamp that max/live.js reads from
# the set (locator "Chorus" at beat 64, playhead at beat 70: bar 18), and the
# doc stored in the set. Nobody can see or click this Mac's screen from an
# agent session, so the logs are the only proof.
# Usage: tools/studio-test.sh [--release]   (about 30 s; Live must not be running)
# --release tests the frozen device (tools/build-release.mjs) instead of a
# development install, and checks that node runs from inside it.
#
# Live stops at a modal question that nobody here can answer in two cases:
# - recovery data from a crash (CrashRecoveryInfo.cfg): the script refuses;
# - an open set with changes, when another set is opened into it: the script
#   starts Live with the test set instead.
set -eu
cd "$(dirname "$0")/.."
LIVE_APP=${LIVE_APP:-/Applications/Ableton Live 12 Suite.app}
VERSION=$(defaults read "$LIVE_APP/Contents/Info" CFBundleShortVersionString | cut -d' ' -f1)
PREFS="$HOME/Library/Preferences/Ableton/Live $VERSION"
LIVE_LOG="$PREFS/Log.txt"
live_running() { pgrep -qf "$LIVE_APP/Contents/MacOS/Live"; }

if live_running; then echo "Live is running. Save and quit it first." >&2; exit 2; fi
if [ -e "$PREFS/CrashRecoveryInfo.cfg" ]; then
  echo "Live has crash recovery data ($PREFS/CrashRecoveryInfo.cfg). Answer its question in Live first." >&2
  exit 2
fi
# The flag alone holds no data ("Running" after a crash).
if [ -e "$PREFS/CrashDetection.cfg" ]; then trash "$PREFS/CrashDetection.cfg"; fi

USER_LIBRARY=$(node -e "console.log(require('./node/library.js').findUserLibrary())")
DEVICE="$USER_LIBRARY/Presets/Audio Effects/Max Audio Effect/Google Docs.amxd"
if [ "${1:-}" = "--release" ]; then
  node tools/build-release.mjs
  mkdir -p "$(dirname "$DEVICE")" "$USER_LIBRARY/Google Docs"
  cp "dist/Google Docs.amxd" "$DEVICE"
  printf '{ "openOnLoad": true }\n' > "$USER_LIBRARY/Google Docs/settings.json"
else
  node tools/install.mjs --open-on-load
fi
DEVICE_LOG="$USER_LIBRARY/Google Docs/logs/device.log"
mkdir -p scratch
STORED=$(node -e 'console.log(encodeURIComponent(JSON.stringify({ v: 1, doc: "studio-test-doc" })))')
node tools/make-test-set.mjs "$DEVICE" scratch/studio-test.als \
  --playhead 70 --locator 0:Intro --locator 64:Chorus --stored "$STORED"

LOG_START=$(($( [ -f "$DEVICE_LOG" ] && wc -l < "$DEVICE_LOG" || echo 0) + 1))
SINCE=$(date +%Y-%m-%dT%H:%M:%S)
new_device_log() { [ -f "$DEVICE_LOG" ] && tail -n +"$LOG_START" "$DEVICE_LOG" || true; }
new_live_log() { awk -v s="$SINCE" 'substr($0, 1, 19) >= s' "$LIVE_LOG"; }

open -a "$LIVE_APP" scratch/studio-test.als
RESULT="timeout after 120 s"
i=0
while [ $i -lt 60 ]; do
  if new_device_log | grep -q 'round trip ok'; then RESULT=ok; sleep 3; break; fi
  if new_live_log | grep -q 'Message Box'; then RESULT="Live shows a question"; break; fi
  # Seen once: Live started with its empty default set instead of ours.
  if new_live_log | grep -q 'Default App: Begin OnNew'; then RESULT="Live started without the test set. Run the script again."; break; fi
  if ! live_running; then RESULT="Live crashed (see ~/Library/Logs/DiagnosticReports/Live-*.ips)"; break; fi
  sleep 2
  i=$((i + 1))
done

echo "--- device log"
new_device_log
if [ "$RESULT" = ok ]; then
  PROBLEMS=""
  new_device_log | grep -q 'live ok \[Chorus · bar 18\]' || PROBLEMS="no stamp \"[Chorus · bar 18]\" from Live"
  new_device_log | grep -q 'doc stored in the set studio-test-doc' || PROBLEMS="${PROBLEMS:+$PROBLEMS; }the stored doc did not come back"
  if [ "${1:-}" = "--release" ] && new_device_log | grep -q 'node started .* from .*/Google Docs/app/node'; then
    PROBLEMS="${PROBLEMS:+$PROBLEMS; }the frozen device ran the development files"
  fi
  if [ -n "$PROBLEMS" ]; then RESULT="$PROBLEMS"; fi
fi
echo "--- Live log: messages and Max"
new_live_log | grep -E 'Message Box|Message from Max' | cut -c1-200 || true

# SIGTERM quits Live cleanly: no crash flag, no recovery question next time.
if live_running; then pkill -f "$LIVE_APP/Contents/MacOS/Live"; fi
i=0
while live_running && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
if live_running; then echo "Live did not quit within 30 s." >&2; fi
echo "RESULT: $RESULT"
[ "$RESULT" = ok ]
