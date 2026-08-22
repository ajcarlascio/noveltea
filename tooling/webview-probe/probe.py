#!/usr/bin/env python3
"""
Runs the built app in a real WebKitGTK webview and reports what storage it got.

This is the engine Tauri uses on Linux (webkit2gtk-4.1), so the answer is the answer
for the desktop shell — unlike Playwright's WebKit, which is a minimal build with no
storage APIs at all and which is what misled us the first time.

It drives the app's own code path rather than a feature-detection approximation: the
app sets `data-db-storage` to "opfs" or "memory", and "memory" means every word is
lost on restart.
"""
import json
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173/projects"
TIMEOUT_SECONDS = 60

PROBE_JS = """
(function () {
  const root = document.documentElement;
  const nav = navigator;
  const sah = typeof FileSystemFileHandle !== "undefined"
    && typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function";
  return JSON.stringify({
    dbStatus: root.dataset.dbStatus || null,
    dbStorage: root.dataset.dbStorage || null,
    isSecureContext: typeof isSecureContext === "boolean" ? isSecureContext : null,
    origin: location.origin,
    hasStorageManager: typeof nav.storage !== "undefined",
    hasIndexedDB: typeof indexedDB !== "undefined",
    hasGetDirectory: typeof nav.storage?.getDirectory === "function",
    hasCreateSyncAccessHandle: sah,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : null,
    userAgent: nav.userAgent
  });
})();
"""

result = {}


def report_and_quit():
    print(json.dumps(result, indent=2))
    Gtk.main_quit()


def on_probe_done(view, task):
    global result
    try:
        value = view.evaluate_javascript_finish(task)
        result = json.loads(value.to_string())
    except Exception as error:  # noqa: BLE001 — the probe reports its own failure
        result = {"error": str(error)}

    # Keep polling until the database has settled; "ready" is what we came for.
    if result.get("dbStatus") in (None, "opening", "migrating"):
        GLib.timeout_add(500, run_probe, view)
        return
    report_and_quit()


def run_probe(view):
    view.evaluate_javascript(PROBE_JS, -1, None, None, None, on_probe_done)
    return False


def on_load_changed(view, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(500, run_probe, view)


window = Gtk.Window(title="NovelTea webview probe")
window.set_default_size(1024, 768)
webview = WebKit2.WebView()
settings = webview.get_settings()
settings.set_enable_developer_extras(True)
webview.connect("load-changed", on_load_changed)
window.add(webview)
window.show_all()
webview.load_uri(URL)


def give_up():
    global result
    if not result:
        result = {"error": f"no result within {TIMEOUT_SECONDS}s", "url": URL}
        report_and_quit()
    return False


GLib.timeout_add_seconds(TIMEOUT_SECONDS, give_up)
Gtk.main()
