import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "./support/manuscript";

/**
 * The outliner, in a real browser and a real replica.
 *
 * The same data the corkboard shows, in the form you need when you are checking pace
 * across the whole book rather than rearranging one level of it. Entirely local.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

async function rename(page: Page, title: string) {
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("treeitem").filter({ hasText: title })).toBeVisible();
}

/** A folder called `title`, selected. */
async function folder(page: Page, title: string) {
  await page.getByRole("button", { name: "New folder" }).click();
  const fresh = page.getByRole("treeitem").filter({ hasText: "New folder" });
  await expect(fresh).toHaveCount(1);
  await fresh.click();
  await rename(page, title);
}

/** A document called `title` holding `text`, saved. */
async function document(page: Page, title: string, text: string) {
  await page.getByRole("button", { name: "New document" }).click();
  const fresh = page.getByRole("treeitem").filter({ hasText: "Untitled" });
  await expect(fresh).toHaveCount(1);
  await fresh.click();
  await rename(page, title);
  await writeManuscript(page, text);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
}

const openOutline = (page: Page) => page.getByRole("button", { name: "Outline" }).click();
/** The title cell of every row, in the order the table draws them. */
const titles = (page: Page) => page.getByRole("rowheader");

test("shows the whole binder in manuscript order, with a folder's words summed", async ({ page }) => {
  await newProject(page);
  await folder(page, "Act One");
  // Created while the folder is selected, so they land inside it.
  await document(page, "The kerb", "Marlowe put the car in gear and drove north.");
  await document(page, "The house", "The house was empty.");

  await openOutline(page);
  await expect(titles(page)).toHaveText(["Act One", "The kerb", "The house"]);

  // Nine words and four. A folder holds no prose of its own, so the useful number is
  // everything beneath it — zero would answer nothing.
  const row = page.getByRole("row").filter({ hasText: "Act One" });
  await expect(row).toContainText("13");
});

test("SORTING REORDERS THE BOOK, AND SAYS IT IS NO LONGER THE BOOK", async ({ page }) => {
  await newProject(page);
  await document(page, "Aaa short", "Two words.");
  await document(page, "Zzz long", "One two three four five six seven.");

  await openOutline(page);
  await expect(page.getByText("In manuscript order.")).toBeVisible();

  await page.getByRole("button", { name: "Words" }).click();
  await expect(titles(page)).toHaveText(["Aaa short", "Zzz long"]);
  // Sorted is a flat list, and the caption says so rather than letting an author read
  // a reordered table as the shape of their book.
  await expect(page.getByText(/flat list rather than the shape/)).toBeVisible();

  await page.getByRole("button", { name: "Words" }).click();
  await expect(titles(page)).toHaveText(["Zzz long", "Aaa short"]);

  // A third click returns to manuscript order. Without it there is no way back to the
  // order the author arranged the book in except reloading.
  await page.getByRole("button", { name: "Words" }).click();
  await expect(page.getByText("In manuscript order.")).toBeVisible();
});

test("the column heading reports its own sort state", async ({ page }) => {
  await newProject(page);
  await document(page, "The kerb", "Marlowe drove north.");

  await openOutline(page);
  const words = page.getByRole("columnheader", { name: "Words" });
  await expect(words).toHaveAttribute("aria-sort", "none");

  await page.getByRole("button", { name: "Words" }).click();
  await expect(words).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Words" }).click();
  await expect(words).toHaveAttribute("aria-sort", "descending");
});

test("picking a row selects that item, and writing returns to it", async ({ page }) => {
  await newProject(page);
  await document(page, "The kerb", "Marlowe drove north.");
  await document(page, "The house", "The house was empty.");

  await openOutline(page);
  await page.getByRole("button", { name: "The kerb" }).click();

  // Back to the manuscript: the outline is where you decide what to work on.
  await page.getByRole("button", { name: "Back to writing" }).click();
  await expect(page.getByRole("heading", { name: "The kerb" })).toBeVisible();
});

test("follows the manuscript as it is written", async ({ page }) => {
  await newProject(page);
  await document(page, "The kerb", "Marlowe drove north.");

  await openOutline(page);
  await expect(titles(page)).toHaveText(["The kerb"]);

  // A second document written from the binder appears without asking for a refresh.
  await page.getByRole("button", { name: "Back to writing" }).click();
  await document(page, "The house", "The house was empty.");
  await openOutline(page);
  await expect(titles(page)).toHaveText(["The kerb", "The house"]);
});
