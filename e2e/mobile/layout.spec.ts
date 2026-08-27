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

    /**
     * A control inside a folded `<details>` is not on screen.
     *
     * Chromium does not hide that content with `display: none` — it uses
     * `content-visibility`, so the boxes are still laid out and still have a size.
     * Nothing paints there, so every one of them fails the hit test, and a panel
     * that is folded away by default would read as a page full of failures.
     */
    const isFolded = (el: Element) => el.closest("details:not([open])") !== null;

    for (const el of document.querySelectorAll("a:not(.skip-link), button, label")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (isInlineInProse(el) || isFolded(el)) continue;

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
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();

  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);

  expect(await unhittableControls(page)).toEqual([]);
});

test("gives every control in the labels panel a target a finger can hit", async ({ page }) => {
  // Folded away by default, and therefore skipped by the check above — so it gets its
  // own test with the panel open. Everything inside it is new: a colour swatch, a
  // name field, two buttons per row.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();

  await page.getByText("Labels and statuses").click();
  await page.getByLabel("New label").fill("Bob's POV");
  await page.getByRole("button", { name: "Add label" }).click();
  await expect(page.getByLabel("Name of Bob's POV")).toBeVisible();
  // Armed, because the confirm button is a control the folded state never shows.
  await page.getByRole("button", { name: "Delete Bob's POV", exact: true }).click();

  expect(await unhittableControls(page)).toEqual([]);
});

test("gives every control in the collections panel a target a finger can hit", async ({
  page,
}) => {
  // Folded away by default, so the check above skips it. Everything inside is new: two
  // name fields, three selects for a saved search's conditions, and two buttons a row.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("treeitem").first().click();

  await page.getByText("Collections", { exact: true }).click();
  await page.getByLabel("New collection").fill("Marlowe");
  await page.getByLabel("Kind", { exact: true }).first().selectOption("search");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Words", { exact: true })).toBeVisible();

  expect(await unhittableControls(page)).toEqual([]);
});

test("gives every control in the word targets panel a target a finger can hit", async ({
  page,
}) => {
  // Folded away by default, so the check above skips it. Two number fields and their
  // labels, which are flex items and so pick up the global 44px floor — asserted
  // rather than assumed, because `min-height` is ignored on an inline box and that is
  // one CSS change away.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();

  await page.getByText("Word targets", { exact: true }).click();
  const daily = page.getByLabel("Words a day");
  await expect(daily).toBeVisible();
  await daily.scrollIntoViewIfNeeded();

  expect(await unhittableControls(page)).toEqual([]);
  for (const text of ["Words a day", "Words in the finished manuscript"]) {
    const box = await page.getByText(text, { exact: true }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("gives every control in the custom fields panel a target a finger can hit", async ({
  page,
}) => {
  // Folded away by default, so the check above skips it. Everything inside is new: a
  // name field, a kind select, a choices field, and the per-item detail controls the
  // panel brings into existence above it.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("treeitem").first().click();

  await page.getByText("Custom fields", { exact: true }).click();
  await page.getByLabel("New field").fill("Eyes");
  await page.getByLabel("Kind of field", { exact: true }).selectOption("select");
  await page.getByLabel("Choices", { exact: true }).fill("Blue, Grey");
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByLabel("Choices for Eyes")).toBeVisible();

  await page.getByLabel("Name of Eyes").scrollIntoViewIfNeeded();
  expect(await unhittableControls(page)).toEqual([]);

  // The detail control the field creates sits above the manuscript, in its own row.
  // Named explicitly because the sweep only reports on whatever is on screen when it
  // runs, and this one is at the other end of a long page.
  const details = page.getByLabel("Eyes", { exact: true });
  await details.scrollIntoViewIfNeeded();
  expect(await unhittableControls(page)).toEqual([]);
  const box = await page.getByText("Eyes", { exact: true }).first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("gives every control in the compile panel a target a finger can hit", async ({ page }) => {
  // Folded away by default, so the check above skips it. Everything inside is new: a
  // preset picker, a name field, and a checkbox per binder item.
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);

  await page.getByText("Compile and trash").click();
  // The selection list is behind a disclosure of its own, so opening the panel is not
  // enough to reach the checkboxes.
  await page.getByText("Including the whole manuscript").click();
  await expect(page.getByRole("checkbox").first()).toBeVisible();

  // Scrolled to, or the sweep proves nothing: it skips anything outside the viewport,
  // and this panel is the last thing on a long page. Without this the check ran over a
  // screen that did not contain a single control it was meant to be checking.
  const picker = page.getByLabel("Preset", { exact: true });
  await picker.scrollIntoViewIfNeeded();
  expect(await unhittableControls(page)).toEqual([]);

  // And the two standalone labels by name, because the sweep can only report on what
  // happens to be on screen when it runs. These are the ones written as `htmlFor`
  // rather than wrapped around their field, so they have no field height to inherit.
  for (const text of ["Preset", "Name this preset"]) {
    const box = await page.getByText(text, { exact: true }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("keeps the corkboard usable on a phone", async ({ page }) => {
  // A whole second view of the manuscript, and one built out of a grid — which is the
  // thing most likely to insist on a minimum width the screen has not got.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);

  await page.getByRole("button", { name: "Corkboard" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(1);

  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  const card = await page.getByRole("listitem").first().boundingBox();
  expect(card, "the board must render a card at all").not.toBeNull();
  expect(Math.round((card?.x ?? 0) + (card?.width ?? 0))).toBeLessThanOrEqual(viewport + 1);

  // Including the reorder buttons, which are the smallest targets on the card.
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
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();

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
      icons: buttons.map((el) => el.querySelectorAll("svg").length),
    };
  });

  // A tripwire, not a rule: it fails when a button is added so that somebody has to
  // come and look at the row count below rather than discovering it on a phone.
  expect(layout.buttons).toBe(8);
  // Eight actions across four rows pushes the manuscript off the screen before an author
  // has written anything. On a phone an icon is what buys the rows back — narrower than
  // any word, including the short ones the tablet layout still shows.
  expect(layout.rows).toBeLessThanOrEqual(2);
  expect(layout.labels.every((label) => label === "")).toBe(true);
  expect(layout.icons.every((count) => count === 1)).toBe(true);
  // This is the assertion the icons depend on. The glyph is decoration and carries no
  // accessible name of its own, so the aria-label is now the ONLY thing a screen reader
  // has: it must stay the full wording, and it must be checked here rather than left
  // behind an earlier expectation that fails first.
  expect(layout.names).toContain("Move to trash");
  expect(layout.names.every((name) => name.length > 0)).toBe(true);
});
