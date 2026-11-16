import { defineConfig, devices } from "@playwright/test";

/**
 * The only end-to-end check that talks to a real server. The stubbed suite in e2e/ cannot
 * see a client that forgets to ask the server for something; this one can.
 *
 *     npm run test:fullstack
 *
 * brings the stack up (deploy/fullstack.compose.yml), runs this, and tears it down.
 */
export default defineConfig({
  testDir: "./e2e/fullstack",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${process.env.NOVELTEA_FULLSTACK_PORT ?? "8197"}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "fullstack", use: { ...devices["Desktop Chrome"] } }],
});
