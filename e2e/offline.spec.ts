import { expect, test } from "@playwright/test";

// The suite blocks service workers (playwright.config.ts); this is the one place that
// needs the real thing.
test.use({ serviceWorkers: "allow" });

test("opens from cold with no network after one visit", async ({ page, context }) => {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  // Offline as soon as the worker is active and controlling: no second, worker-served
  // visit first, so the precache alone has to hold the shell.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await context.setOffline(true);
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await expect(page.getByText(/no projects yet/i)).toBeVisible();
});
