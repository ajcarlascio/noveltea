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
adb logcat -d > "$OUT/logcat-full.txt"
grep -E "chromium|Console|FATAL|AndroidRuntime|RustStdoutStderr|$PKG" "$OUT/logcat-full.txt" > "$OUT/logcat.txt" || true
exit 0
