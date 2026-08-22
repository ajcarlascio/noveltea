import { expect, test, type Page } from "@playwright/test";
import { hasOpfs } from "./support/storage";

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

test("uses persistent storage where the engine has it", async ({ page }) => {
  await page.goto("/projects");
  const state = await replicaState(page);

  expect(state.status).toBe("ready");
  expect(state.schema).toBeGreaterThan(0);

  if (await hasOpfs(page)) {
    // Falling back to memory here would mean the author's work is not being stored,
    // and everything else in this repo passes just as happily in that state.
    expect(state.storage).toBe("opfs");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } else {
    // The supported degraded state, and the one that must never be quiet: the app
    // still runs, and says plainly that nothing is being kept.
    expect(state.storage).toBe("memory");
    await expect(page.getByRole("alert")).toContainText(/not storing your work/i);
  }
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
  await page.goto("/projects");
  test.skip(!(await hasOpfs(page)), "This engine has no OPFS; there is nothing to persist.");

  // First visit in this browser context creates the file and applies everything.
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

test("keeps working, and says so, when the engine cannot persist", async ({ page }) => {
  await page.goto("/projects");
  test.skip(await hasOpfs(page), "This engine persists; the degraded path is elsewhere.");

  await expect(page.getByRole("alert")).toContainText(/lost when you close this tab/i);

  // Usable regardless. Refusing to run would be worse than running without a net,
  // as long as the net's absence is stated.
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
});
