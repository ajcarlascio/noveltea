import { expect, test } from "@playwright/test";

// The suite blocks service workers (playwright.config.ts); this is the one place that
// needs the real thing.
test.use({ serviceWorkers: "allow" });

test("opens from cold with no network after one visit", async ({ page, context }) => {
  await page.goto("/projects");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Reload under the worker's control, so it has also served the page once.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await expect(page.getByText(/no projects yet/i)).toBeVisible();
});
