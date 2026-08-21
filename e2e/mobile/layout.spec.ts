import { expect, test } from "@playwright/test";

/**
 * Runs under the "mobile" project in playwright.config.ts, which supplies a phone
 * viewport, a coarse pointer and a touch-capable user agent. Adding another device
 * is a project entry there, not a change here.
 */

test("gives every control a target a finger can hit", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  const small = await page.evaluate(() => {
    const offenders: string[] = [];
    for (const el of document.querySelectorAll("a:not(.skip-link), button, label")) {
      const { width, height } = el.getBoundingClientRect();
      // Zero-sized elements are hidden, not undersized.
      if (width === 0 && height === 0) continue;
      if (height < 44) {
        offenders.push(`${el.tagName}"${(el.textContent ?? "").trim().slice(0, 20)}" ${Math.round(width)}x${Math.round(height)}`);
      }
    }
    return offenders;
  });

  // 44px is the floor in Apple's HIG; Material rounds up from it. Below that,
  // taps land beside their target and the app feels broken rather than dense.
  expect(small).toEqual([]);
});

test("nothing is wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });

  for (const path of ["/projects", "/settings"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();

    const offenders = await page.evaluate(() => {
      // Measuring documentElement.scrollWidth would prove nothing: the app's scroll
      // container is the main pane, so anything too wide overflows *inside* it and
      // the document never grows. Every box gets checked against the viewport, and
      // every scrollable pane against its own content.
      const viewport = document.documentElement.clientWidth;
      const found: string[] = [];

      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > viewport + 1 || rect.left < -1) {
          found.push(
            `${el.tagName}.${el.className || "-"} spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${viewport}`,
          );
        }
        if (el.scrollWidth - el.clientWidth > 1) {
          found.push(
            `${el.tagName}.${el.className || "-"} scrolls sideways by ${el.scrollWidth - el.clientWidth}px`,
          );
        }
      }
      return found;
    });

    // Sideways scroll on a phone means the reader loses their place in a direction
    // they never chose to move.
    expect(offenders, `on ${path}`).toEqual([]);
  }
});
