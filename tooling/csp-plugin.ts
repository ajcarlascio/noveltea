import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/**
 * Injects a Content-Security-Policy into the built index.html.
 *
 * Build only. Vite's dev server serves its own inline HMR scripts, so a strict
 * policy in development would block the tooling rather than any attacker.
 *
 * Hashes for inline scripts are computed here rather than written by hand: the
 * theme pre-paint script in index.html must keep running, and a hand-copied hash
 * is a hash that goes stale the first time someone edits it — silently taking the
 * script out and bringing back the flash of the wrong theme.
 */
export function contentSecurityPolicy(): Plugin {
  return {
    name: "noveltea:csp",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      // Set by the desktop build. A browser build must not carry these, since naming
      // schemes it will never use only widens the policy.
      const hosted = process.env.NOVELTEA_TAURI === "1";

      const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1] ?? "")
        .filter((source) => source.trim().length > 0)
        .map((source) => `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`);

      const policy = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        // No frame-ancestors here: browsers ignore it when the policy arrives in a
        // <meta> element, and it logs a console warning saying so. Listing it would
        // buy nothing except the false impression that framing is blocked. Clickjacking
        // protection has to come from the server's response headers — see the README.
        "form-action 'none'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        // 'wasm-unsafe-eval' is required to compile sqlite-wasm. It permits
        // WebAssembly compilation and nothing else — it is not 'unsafe-eval'.
        `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`.trim(),
        // The database worker, and sqlite-wasm's own OPFS proxy worker.
        "worker-src 'self' blob:",
        // Deliberately open. NovelTea is self-hosted: the server is whatever address
        // the author types at sign-in, so there is no origin to allow at build time.
        //
        // `*` does not cover custom schemes, which is why the desktop build has to name
        // Tauri's IPC endpoints explicitly. Without them `invoke` is blocked before it
        // leaves the webview, and both sides fail quietly: the host never hears a
        // request, and the page catches an error it cannot distinguish from a missing
        // file. That looked exactly like "the desktop app does not persist anything".
        hosted ? "connect-src * ipc: http://ipc.localhost" : "connect-src *",
      ].join("; ");

      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: policy },
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}
