import { expect, test, type Page } from "@playwright/test";

/**
 * The corkboard against a real browser and a real OPFS database.
 *
 * The unit tests cover the reads, the writes and the ordering arithmetic. What only a
 * real browser can show is that a synopsis survives a reload — the whole promise of a
 * local replica — and that dragging a card actually moves it, which jsdom has no pointer
 * to attempt.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole("treeitem").filter({ hasText: name });

async function rename(page: Page, to: string) {
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New title").fill(to);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, to)).toBeVisible();
}

/** Two named documents at the top level, in order. */
async function twoScenes(page: Page) {
  await newProject(page);
  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();
  await rename(page, "Arrival");

  // Deselect first, or the new document lands beside the selected one in a way the
  // test would then have to reason about.
  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();
  await rename(page, "Departure");
}

const cardTitles = (page: Page) =>
  page.getByRole("listitem").locator("h3").allTextContents();

test("writes a synopsis that is still there after a reload", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();
  await rename(page, "Arrival");

  await page.getByRole("button", { name: "Corkboard" }).click();
  await page
    .getByLabel("Synopsis of Arrival")
    .fill("She reaches the island at dusk and nobody is waiting.");
  // Saved on blur, which is what leaving the field means.
  await page.getByRole("heading", { name: "Untitled project" }).click();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "Corkboard" }).click();

  // The point of a local replica: this never went near a server and it is still here.
  await expect(page.getByLabel("Synopsis of Arrival")).toHaveValue(
    "She reaches the island at dusk and nobody is waiting.",
  );
});

test("reorders with the buttons, and the binder agrees", async ({ page }) => {
  await twoScenes(page);
  await page.getByRole("button", { name: "Corkboard" }).click();
  expect(await cardTitles(page)).toEqual(["Arrival", "Departure"]);

  await page.getByRole("button", { name: "Move Departure earlier" }).click();
  await expect
    .poll(() => cardTitles(page))
    .toEqual(["Departure", "Arrival"]);

  // The board and the binder are two views of one order, not two orders.
  await page.getByRole("button", { name: "Back to writing" }).click();
  const rows = await page.getByRole("treeitem").allTextContents();
  expect(rows.findIndex((text) => text.includes("Departure"))).toBeLessThan(
    rows.findIndex((text) => text.includes("Arrival")),
  );
});

test("reorders by dragging one card onto another", async ({ page }) => {
  await twoScenes(page);
  await page.getByRole("button", { name: "Corkboard" }).click();
  expect(await cardTitles(page)).toEqual(["Arrival", "Departure"]);

  // Dropping on a card means "go in front of this one".
  await page
    .getByRole("listitem")
    .filter({ hasText: "Departure" })
    .dragTo(page.getByRole("listitem").filter({ hasText: "Arrival" }));

  await expect.poll(() => cardTitles(page)).toEqual(["Departure", "Arrival"]);
});

test("drills into a folder and opens a document from its card", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "New folder" }).click();
  await row(page, "New folder").click();
  await rename(page, "Act One");
  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();
  await rename(page, "Arrival");

  await page.getByRole("button", { name: "Corkboard" }).click();

  // The board opens on the level the author is already looking at, which with a
  // document selected is the folder holding it.
  await expect(page.getByLabel("Synopsis of Arrival")).toBeVisible();

  // Up to the top via the trail, where the only card is the folder itself.
  await page.getByRole("button", { name: "Untitled project" }).click();
  const folderCard = page.getByRole("listitem").filter({ hasText: "Act One" });
  await expect(folderCard).toBeVisible();
  // A folder card says what is behind it rather than pretending to a summary.
  await expect(folderCard.getByText("1 item")).toBeVisible();
  await expect(page.getByLabel("Synopsis of Act One")).toHaveCount(0);

  await folderCard.locator("h3 button").click();
  await expect(page.getByRole("listitem").filter({ hasText: "Arrival" })).toBeVisible();

  await page.getByRole("listitem").filter({ hasText: "Arrival" }).locator("h3 button").click();
  // Opening a card is a way into the scene: the editor, on that document.
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toBeVisible();
});

test("says a level is empty rather than showing a blank board", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "Corkboard" }).click();
  await expect(page.getByText(/nothing here yet/i)).toBeVisible();
});
