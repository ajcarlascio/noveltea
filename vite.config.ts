import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Tauri points its webview at this origin in development.
    port: 5173,
    strictPort: true,
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
    setupFiles: ["./vitest.setup.ts"],
    css: true,
    restoreMocks: true,
  },
});
