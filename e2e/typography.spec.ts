import { expect, test } from "@playwright/test";

/**
 * Typography, in a real browser: the choices an author makes about how their own
 * manuscript looks, and the one number that must not move when they make them.
 *
 * The two tests that need a document navigate through the app's own links rather than
 * `page.goto`. A goto is a full reload, and on an engine with no OPFS — WebKit here —
 * that empties the in-memory replica and takes the project with it.
 */

/** Settings and back, without leaving the page. */
async function visitSettings(
  page: import("@playwright/test").Page,
  change: () => Promise<void>,
) {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await change();

  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  // The selected document is not in the URL, so returning lands on the project with
  // nothing open.
  await page.getByRole("treeitem").first().click();
}

async function openDocument(page: import("@playwright/test").Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByRole("treeitem").first().click();
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toBeVisible();
}

test("offers more than one face, and remembers the choice across a reload", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("radio", { name: /^EB Garamond/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-font", "eb-garamond");

  await page.reload();
  // Applied before first paint, so it is already right on arrival rather than after.
  await expect(page.locator("html")).toHaveAttribute("data-font", "eb-garamond");
});

test("changes the size of the manuscript and the column together", async ({ page }) => {
  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  const before = await surface.evaluate((el) => ({
    size: parseFloat(getComputedStyle(el).fontSize),
    width: parseFloat(getComputedStyle(el).maxWidth),
  }));

  await visitSettings(page, async () => {
    await page.getByRole("radio", { name: "Extra large", exact: true }).check();
  });
  await expect(surface).toBeVisible();

  const after = await surface.evaluate((el) => ({
    size: parseFloat(getComputedStyle(el).fontSize),
    width: parseFloat(getComputedStyle(el).maxWidth),
  }));

  expect(after.size).toBeGreaterThan(before.size);
  // The measure is in em, so the column grows with the type and the line length in
  // characters stays put. In rem the text would get bigger and every line shorter.
  expect(after.width).toBeGreaterThan(before.width);
});

test("PAGE COUNT DOES NOT MOVE WHEN THE READING SIZE DOES", async ({ page }) => {
  await openDocument(page);
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click({ position: { x: 12, y: 12 } });
  await surface.fill("word ".repeat(300));
  await expect(page.getByText(/2 pages/)).toBeVisible({ timeout: 10_000 });

  await visitSettings(page, async () => {
    await page.getByRole("radio", { name: "Small", exact: true }).check();
  });

  // Standard manuscript pages, at 250 words each. An author reading in small type has
  // not written a shorter book, and two writers' page counts have to be comparable.
  await expect(page.getByText(/2 pages/)).toBeVisible({ timeout: 10_000 });
});
