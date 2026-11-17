#!/usr/bin/env bash
# Runs inside the emulator step: installs the APK, starts the app, and writes evidence to
# probe/. Exits non-zero only if the app cannot be installed or started; what the app says
# about its storage is reported, not judged.
set -uo pipefail
PKG=io.github.ajcarlascio.noveltea
OUT=probe
mkdir -p "$OUT"

adb wait-for-device
adb logcat -c
adb install -r "$1" || { echo "install failed" > "$OUT/verdict.txt"; exit 1; }
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 || { echo "launch failed" > "$OUT/verdict.txt"; exit 1; }
sleep 20

PID=$(adb shell pidof "$PKG" | tr -d '\r' | awk '{print $1}')
if [ -z "$PID" ]; then
  echo "process not running after launch (crashed?)" > "$OUT/verdict.txt"
  adb logcat -d > "$OUT/logcat-full.txt"
  adb exec-out screencap -p > "$OUT/screenshot.png"
  grep -E "FATAL|AndroidRuntime|$PKG" "$OUT/logcat-full.txt" > "$OUT/logcat.txt"
  exit 1
fi
echo "pid $PID"
adb shell cat /proc/net/unix | grep devtools_remote > "$OUT/devtools-sockets.txt" || true
adb forward tcp:9222 "localabstract:webview_devtools_remote_$PID"
node tooling/webview-state.mjs 9222 120 > "$OUT/state.json" 2> "$OUT/state.err"
echo "state exit $?"; cat "$OUT/state.json" "$OUT/state.err"

adb exec-out screencap -p > "$OUT/screenshot.png"

# Does what is written survive the app being stopped? A project is made through the page,
# the process is killed, and the second launch is asked whether the project is still there.
# Reported, not judged, like the storage answer: a "no" is the finding.
node tooling/webview-state.mjs 9222 60 "New project" "Untitled project" > "$OUT/written.json" 2>> "$OUT/state.err"
sleep 5 # the write is a round trip to the native side; give it time to land before the kill
adb forward --remove tcp:9222
adb shell am force-stop "$PKG"
sleep 3
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
sleep 15
PID2=$(adb shell pidof "$PKG" | tr -d '\r' | awk '{print $1}')
if [ -n "$PID2" ] && [ "$PID2" != "$PID" ]; then
  adb forward tcp:9222 "localabstract:webview_devtools_remote_$PID2"
  node tooling/webview-state.mjs 9222 90 "" "Untitled project" > "$OUT/restarted.json" 2>> "$OUT/state.err"
  adb exec-out screencap -p > "$OUT/screenshot-restarted.png"
else
  echo "second launch did not start a new process (pid '$PID2')" >> "$OUT/state.err"
fi
cat "$OUT/written.json" "$OUT/restarted.json" 2>/dev/null

adb logcat -d > "$OUT/logcat-full.txt"
grep -E "chromium|Console|FATAL|AndroidRuntime|RustStdoutStderr|$PKG" "$OUT/logcat-full.txt" > "$OUT/logcat.txt" || true
exit 0
