import { expect, test, type Page } from "@playwright/test";
import { hasOpfs } from "./support/storage";

/**
 * The editor against a real browser and a real OPFS database: TipTap, autosave and
 * the local replica meeting each other. The unit tests cover each in isolation.
 */

async function openDocument(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();

  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("treeitem").first().click();
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toBeVisible();
}

test("writes, counts and saves", async ({ page }) => {
  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });

  await surface.click();
  await surface.pressSequentially("The lighthouse kept its own hours.");

  await expect(page.getByText("6 words")).toBeVisible();

  // "Saved" is also the state before anything is typed, so asserting it alone proves
  // nothing. Waiting for the transition — dirty, then clean — is what shows a write
  // actually happened. Autosave settles on its own; the author is never asked.
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 5000 });
});

test("keeps the prose across a reload", async ({ page }) => {
  await page.goto("/projects");
  test.skip(!(await hasOpfs(page)), "This engine has no OPFS; a reload keeps nothing.");

  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click();
  await surface.pressSequentially("Salt on the window.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 5000 });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
  await page.getByRole("treeitem").first().click();

  await expect(page.getByRole("textbox", { name: "Manuscript" })).toContainText(
    "Salt on the window.",
  );
});

test("does not lose the last words when switching documents", async ({ page }) => {
  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click();
  await surface.pressSequentially("First document.");

  // Straight to another document without waiting for the debounce. This is the
  // moment work goes missing: nothing fails, the last sentence simply never lands.
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(2);
  await page.getByRole("treeitem").nth(1).click();
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toBeVisible();

  await page.getByRole("treeitem").first().click();
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toContainText("First document.");
});

test("shows a folder no editor", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("treeitem").first().click();

  await expect(page.getByRole("textbox", { name: "Manuscript" })).toHaveCount(0);
  await expect(page.getByText(/folders hold documents/i)).toBeVisible();
});

test("keeps the binder toolbar on one row", async ({ page }) => {
  await openDocument(page);

  const rows = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"]');
    const tops = [...(toolbar?.querySelectorAll("button") ?? [])].map((el) =>
      Math.round(el.getBoundingClientRect().top),
    );
    return new Set(tops).size;
  });

  // Wrapping a toolbar across two lines on a wide screen wastes the dimension there
  // is most of, and moves the buttons as the selection enables and disables them.
  expect(rows).toBe(1);
});

test("finds synonyms offline, without sending anything", async ({ page }) => {
  // Any request to a third party fails this outright: the offline thesaurus is the
  // default, and the whole claim is that it needs no network.
  const outbound: string[] = [];
  await page.route("**://*/**", (route) => {
    const url = route.request().url();
    if (!url.startsWith("http://127.0.0.1:4173")) outbound.push(url);
    return route.continue();
  });

  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click();
  await surface.pressSequentially("She was furious");

  // Lookup sits behind a fold: it is occasional, and the prose is not.
  await page.getByText("Word lookup").click();
  await page.getByRole("button", { name: "Synonyms" }).click();

  // Proves the generated index is served, parses, and answers in a real browser.
  await expect(page.getByRole("button", { name: "enraged" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".lookup__local")).toContainText(/on this device/);
  expect(outbound).toEqual([]);
});

test("puts a chosen synonym into the manuscript", async ({ page }) => {
  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click();
  await surface.pressSequentially("She was furious");
  // Selecting the whole line would make the lookup term the sentence, which has no
  // synonyms — the word under the cursor is what the panel is for.
  await surface.press("Shift+ControlOrMeta+ArrowLeft");

  // Lookup sits behind a fold: it is occasional, and the prose is not.
  await page.getByText("Word lookup").click();
  await page.getByRole("button", { name: "Synonyms" }).click();
  await page.getByRole("button", { name: "enraged" }).click({ timeout: 20_000 });

  // Chosen with a selection in place, so it replaces rather than appends.
  await expect(surface).toContainText("She was enraged");
  await expect(surface).not.toContainText("furious");
});
