import { expect, test, type Page } from "@playwright/test";

/**
 * Proves what the unit tests cannot: that sqlite-wasm really loads, that OPFS
 * really persists, and that a reload really finds the database again.
 *
 * There is no test-only handle on `window`. The app mirrors the replica's state
 * onto <html> as data attributes — useful for supporting an author, and enough
 * for these tests to distinguish a persisted database from a fresh one without
 * shipping a backdoor that would also exist in production.
 */

async function replicaState(page: Page) {
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-db-status", /ready|failed/, { timeout: 30_000 });
  return {
    status: await root.getAttribute("data-db-status"),
    storage: await root.getAttribute("data-db-storage"),
    applied: Number(await root.getAttribute("data-db-applied")),
    schema: Number(await root.getAttribute("data-db-schema")),
  };
}

test("opens a persistent replica, not an in-memory fallback", async ({ page }) => {
  await page.goto("/projects");
  const state = await replicaState(page);

  expect(state.status).toBe("ready");
  // "memory" would mean the author's work is not being stored. Everything else in
  // this repo passes just as happily in that state, which is why it is asserted here.
  expect(state.storage).toBe("opfs");
  expect(state.schema).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("runs the migrations and answers a real query through the worker", async ({ page }) => {
  await page.goto("/projects");
  await replicaState(page);

  // An empty list rendered from a real SELECT is a stronger signal than any
  // assertion about internals: the worker started, the wasm loaded, the migrations
  // created `project`, and the query came back.
  await expect(page.getByText(/no projects yet/i)).toBeVisible();
});

test("finds the same database on the next visit instead of rebuilding it", async ({ page }) => {
  // First visit in this browser context creates the file and applies everything.
  await page.goto("/projects");
  const first = await replicaState(page);
  expect(first.applied).toBeGreaterThan(0);

  await page.reload();
  const second = await replicaState(page);

  // Zero migrations applied means the database was already there — the file
  // survived the reload. An in-memory fallback would re-apply all of them, so this
  // is the assertion the whole storage layer exists to satisfy.
  expect(second.applied).toBe(0);
  expect(second.storage).toBe("opfs");
  expect(second.schema).toBe(first.schema);
});
