import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { contentSecurityPolicy } from "./tooling/csp-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Tauri points its webview at this origin in development.
    port: 5173,
    strictPort: true,
  },
  preview: {
    // Pinned to IPv4 on purpose. `vite preview` otherwise binds "localhost", which on
    // a CI runner resolves to ::1 first, while Playwright polls http://127.0.0.1 —
    // so the server is up and the harness waits out its timeout regardless. The
    // failure reads as "the app never started", which is not what happened.
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  worker: {
    // The database worker imports ESM (sqlite-wasm, client-db). The legacy "iife"
    // worker format cannot express that.
    format: "es",
  },
  optimizeDeps: {
    // sqlite-wasm resolves sqlite3.wasm relative to its own loader; pre-bundling moves
    // the loader and the fetch 404s. client-db is raw TypeScript from a workspace, so it
    // wants Vite's normal transform rather than the esbuild pre-bundle.
    exclude: ["@sqlite.org/sqlite-wasm", "@noveltea/client-db"],
  },
  build: {
    // Tauri v2 ships a modern webview on every platform we target; browsers get
    // the same bundle. Neither needs the ES5 tax.
    target: "es2022",
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    // The server repo is vendored as a submodule for its schema, not its test
    // suite. Its packages run under `node --test`, so Vitest collecting them
    // reports failures that mean nothing here and hide the ones that do.
    // e2e/ is Playwright's; its specs would fail meaninglessly under Vitest.
    exclude: [...configDefaults.exclude, "vendor/**", "e2e/**"],
    setupFiles: ["./vitest.setup.ts"],
    css: true,
    restoreMocks: true,
  },
});
