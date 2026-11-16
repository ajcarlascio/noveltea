/**
 * Registers the service worker that lets the web build open without a network.
 *
 * Only in a production browser tab. Dev would cache stale modules under Vite's feet;
 * the desktop shell already has every file on disk, and a worker there would only be a
 * second, unmanaged copy of them. Service workers need a secure context (HTTPS or
 * localhost) — elsewhere the app simply works online, as before.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || import.meta.env.MODE === "tauri") return;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    // A failed registration costs offline start, not the app; nothing to tell the author.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
