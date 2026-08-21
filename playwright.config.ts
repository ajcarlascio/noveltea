import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end checks that need a real browser.
 *
 * Everything about the local replica that matters — OPFS actually persisting, the
 * worker actually starting, sqlite-wasm actually loading its .wasm — is invisible
 * to the unit tests, which run against node:sqlite. Those tests prove the SQL and
 * the wiring; only a browser proves the storage.
 *
 * Runs against the production build rather than the dev server, because the thing
 * most likely to break is asset resolution for the worker and the wasm file, and
 * dev serves those differently from a bundle.
 */
/**
 * WebKit is opt-in. Its browser binary comes from `npx playwright install webkit`, but it
 * also needs system libraries that only root can install:
 *
 *     sudo npx playwright install-deps webkit
 *
 * Without them every WebKit test fails at browser launch, which would make the default
 * run red for a reason that has nothing to do with the code. So it runs only when asked:
 *
 *     npm run test:e2e:webkit
 *
 * It is worth asking for. WebKit is what iOS (WKWebView) and Linux Tauri (WebKitGTK)
 * actually run, and dvh, :has(), OPFS and CSP enforcement are exactly where it and
 * Chromium diverge — Chromium passing says nothing about either.
 */
const includeWebKit = process.env.NOVELTEA_WEBKIT === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/mobile/**",
    },
    {
      // A coarse pointer and a phone viewport. Device descriptors set
      // defaultBrowserType, which Playwright only accepts at project level — which
      // is why the phone specs live in their own directory.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: "**/mobile/**",
    },
    ...(includeWebKit
      ? [
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
            testIgnore: "**/mobile/**",
          },
          {
            name: "mobile-safari",
            use: { ...devices["iPhone 13"] },
            testMatch: "**/mobile/**",
          },
        ]
      : []),
  ],
  webServer: {
    // Host and port come from vite.config.ts so this and the server cannot disagree.
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    // A cold CI runner builds from nothing; 120s was not enough headroom once the
    // font and the editor joined the bundle.
    timeout: 240_000,
    // Without these a build failure surfaces only as "timed out waiting for
    // webServer", with the compiler's explanation swallowed.
    stdout: "pipe",
    stderr: "pipe",
  },
});
