import { expect, test } from "@playwright/test";

/**
 * Runs under the "mobile" project in playwright.config.ts, which supplies a phone
 * viewport, a coarse pointer and a touch-capable user agent. Adding another device
 * is a project entry there, not a change here.
 */

/**
 * Hit-testing, not measuring. Buttons are deliberately smaller than their target on a
 * phone — compact pills with a transparent overlay extending what a finger can reach —
 * so a bounding box says nothing about whether a tap lands. This asks the browser the
 * same question the finger does.
 */
async function unhittableControls(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const MIN = 44;
    const found: string[] = [];

    const hittable = (el: Element, x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };

    /**
     * A link flowing inside a sentence is exempt.
     *
     * WCAG 2.5.5 makes this exception deliberately: enforcing 44px on inline links
     * would mean no link could ever appear mid-paragraph, which is worse for reading
     * than it is better for tapping. The rule is for standalone controls — buttons,
     * nav items, anything a finger goes hunting for.
     */
    const isInlineInProse = (el: Element) => {
      if (el.tagName !== "A") return false;
      if (getComputedStyle(el).display !== "inline") return false;
      const parentText = (el.parentElement?.textContent ?? "").trim();
      return parentText.length > (el.textContent ?? "").trim().length;
    };

    for (const el of document.querySelectorAll("a:not(.skip-link), button, label")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (isInlineInProse(el)) continue;

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Half a pixel inside the boundary: a point exactly on the edge of a 44px
      // target belongs to whatever is drawn next, so probing at exactly MIN/2 tests
      // the neighbour rather than the control.
      const reach = MIN / 2 - 0.5;

      if (cy - reach < 0 || cy + reach > window.innerHeight) continue; // off screen
      for (const dy of [-reach, 0, reach]) {
        if (!hittable(el, cx, cy + dy)) {
          found.push(
            `${el.tagName}"${(el.textContent ?? "").trim().slice(0, 20)}" not hittable ${dy}px from its centre`,
          );
          break;
        }
      }
    }
    return found;
  });
}

test("gives every control on the settings page a target a finger can hit", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // 44px is the floor in Apple's HIG; Material rounds up from it. Below that, taps
  // land beside their target and the app feels broken rather than dense.
  expect(await unhittableControls(page)).toEqual([]);
});

test("gives every control in the binder a target a finger can hit", async ({ page }) => {
  // The binder toolbar is where the buttons are, and buttons are the controls whose
  // visible box is deliberately smaller than their target. Testing only the settings
  // page would leave that entirely uncovered — it has labels and links and no buttons.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();

  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);

  expect(await unhittableControls(page)).toEqual([]);
});

test("nothing is wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });

  // The binder is included by building one first. Checking only /projects and
  // /settings would leave the toolbar — the widest row in the app, and the one most
  // likely to overflow — untested, which is exactly what it did.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();
  const binderPath = new URL(page.url()).pathname;

  for (const path of ["/projects", "/settings", binderPath, "/signin"]) {
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
        // Only where the reader could actually scroll. An element with
        // `overflow: hidden` and an ellipsis is clipping on purpose — its
        // scrollWidth exceeds its box by design, and nobody can scroll it, so
        // flagging it would mean forbidding text truncation altogether.
        const overflowX = getComputedStyle(el).overflowX;
        const scrollable = overflowX === "auto" || overflowX === "scroll";
        if (scrollable && el.scrollWidth - el.clientWidth > 1) {
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

test("keeps the binder toolbar to two rows at most", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();

  const layout = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"]');
    const buttons = [...(toolbar?.querySelectorAll("button") ?? [])];
    return {
      buttons: buttons.length,
      rows: new Set(buttons.map((el) => Math.round(el.getBoundingClientRect().top))).size,
      // innerText, not textContent: both labels are in the DOM and CSS decides which
      // is shown, so textContent would report the hidden one too.
      labels: buttons.map((el) => (el as HTMLElement).innerText.trim()),
      names: buttons.map((el) => el.getAttribute("aria-label") ?? ""),
    };
  });

  expect(layout.buttons).toBe(5);
  // Five actions across four rows pushes the binder off the screen before an author
  // has written anything. Short labels are what buy the second row back.
  expect(layout.rows).toBeLessThanOrEqual(2);
  expect(layout.labels).toContain("Trash");
  // The accessible name stays the full wording whatever the screen is doing, so a
  // screen reader never hears an abbreviation the sighted reader does not see.
  expect(layout.names).toContain("Move to trash");
});
