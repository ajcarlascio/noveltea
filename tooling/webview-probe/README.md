# Webview probe

Runs the built app in a **real WebKitGTK webview** — `webkit2gtk-4.1`, the engine Tauri
uses on Linux — and reports what storage it actually got.

```sh
npm run build
npx vite preview --port 4173 &
python3 tooling/webview-probe/probe.py http://127.0.0.1:4173/projects
```

Needs `python3-gi` and `gir1.2-webkit2-4.1`, and a display (WSLg counts).

## Why this exists

Playwright's WebKit is a deliberately minimal build with no storage APIs at all, so it
cannot answer questions about what a *shipped* WebKit does. Using it as a proxy for
WebKitGTK is how we got this wrong — first by asserting it, then by doubting it —
without either being evidence.

The probe drives the app's own code path rather than a feature-detection approximation:
the app sets `data-db-storage` to `opfs` or `memory`, and `memory` means every word is
lost on restart.

## Result on WebKitGTK 2.52.3 (Ubuntu 26.04, August 2026)

```json
{
  "dbStorage": "memory",
  "isSecureContext": true,
  "hasStorageManager": false,
  "hasIndexedDB": true,
  "hasGetDirectory": false,
  "hasCreateSyncAccessHandle": false,
  "hasSharedArrayBuffer": false
}
```

`navigator.storage` is absent **entirely** — not gated behind a secure context, which
`isSecureContext: true` alongside a working `indexedDB` rules out. This is a current
release, not an old one, so it is the state of Linux desktop rather than a version to
wait out.

Re-run this before assuming anything has changed.
