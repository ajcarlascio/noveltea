import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "./support/manuscript";

/**
 * Collections, in a real browser and a real replica.
 *
 * No server is stubbed, and none is needed: a saved search is answered against the
 * local database, which is the whole point of it. An author on a train who cannot ask
 * "which scenes is Marlowe in" has lost the feature, not deferred it.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole("treeitem").filter({ hasText: name });

const openPanel = (page: Page) => page.getByText("Collections", { exact: true }).click();

/** A document called `title` holding `text`, left saved. */
async function writeScene(page: Page, title: string, text: string) {
  await page.getByRole("button", { name: "New document" }).click();
  // The fresh row by name, not `.last()`. The click returns before the write and the
  // re-render behind it, so `.last()` resolves to the *previous* document and the
  // rename below lands on that one instead — which reads later as a search that
  // cannot find text that is plainly there.
  const fresh = page.getByRole("treeitem").filter({ hasText: "Untitled" });
  await expect(fresh).toHaveCount(1);
  await fresh.click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, title)).toBeVisible();

  await writeManuscript(page, text);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
}

async function addCollection(page: Page, name: string, kind: "list" | "search") {
  await page.getByLabel("New collection").fill(name);
  await page.getByLabel("Kind", { exact: true }).first().selectOption(kind);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel(`Name of ${name}`)).toHaveValue(name);
}

/** The titles the binder pane is showing, whichever view it is in. */
const showing = (page: Page) => page.getByRole("list", { name: "Marlowe" }).getByRole("button");

// `{ exact: true }` on the "Words" field below is load-bearing. The word-targets panel
// on the same page has "Words a day" and "Words in the finished manuscript", and a
// substring match finds all three. Each name is distinct and descriptive; it was the
// locator that was loose.

test("a saved search finds every scene a name appears in, with no server", async ({ page }) => {
  await newProject(page);
  await writeScene(page, "The kerb", "Marlowe put the car in gear and drove north.");
  await writeScene(page, "The house", "The house was empty and the telephone rang twice.");

  await openPanel(page);
  await addCollection(page, "Marlowe", "search");
  await page.getByLabel("Words", { exact: true }).fill("marlowe");
  // Saved on leaving the field, so the blur is the write.
  await page.getByLabel("New collection").click();
  await openPanel(page);

  await page.getByLabel("Showing").selectOption({ label: "Marlowe" });
  await expect(showing(page)).toHaveText(["The kerb"]);
});

test("A SAVED SEARCH FOLLOWS THE PROSE, WITH NO REFRESH", async ({ page }) => {
  await newProject(page);
  await writeScene(page, "The house", "The house was empty.");

  await openPanel(page);
  await addCollection(page, "Marlowe", "search");
  await page.getByLabel("Words", { exact: true }).fill("marlowe");
  await page.getByLabel("New collection").click();
  await openPanel(page);

  await page.getByLabel("Showing").selectOption({ label: "Marlowe" });
  await expect(page.getByText("Nothing matches this search yet.")).toBeVisible();

  // Rewriting the scene puts it in the collection. There is no membership row to
  // update and nothing to refresh: the query is answered when the list is drawn.
  await writeManuscript(page, "Marlowe came back for the envelope.");
  await expect(showing(page)).toHaveText(["The house"]);
});

test("a list holds what is put on it, and lets it go again", async ({ page }) => {
  await newProject(page);
  await writeScene(page, "The kerb", "Marlowe put the car in gear.");

  await openPanel(page);
  await addCollection(page, "Marlowe", "list");
  await page.getByRole("button", { name: "Add The kerb" }).click();
  await expect(page.getByRole("button", { name: "Remove The kerb" })).toBeVisible();

  await openPanel(page);
  await page.getByLabel("Showing").selectOption({ label: "Marlowe" });
  await expect(showing(page)).toHaveText(["The kerb"]);

  // And survives the database being reopened, which is the only proof the membership
  // reached storage rather than React state.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByLabel("Showing").selectOption({ label: "Marlowe" });
  await expect(showing(page)).toHaveText(["The kerb"]);

  await openPanel(page);
  await page.getByRole("button", { name: "Remove The kerb" }).click();
  await expect(page.getByText("Nothing on this list yet.", { exact: false })).toBeVisible();
});

test("a list is not offered a saved search's members", async ({ page }) => {
  await newProject(page);
  await writeScene(page, "The kerb", "Marlowe put the car in gear.");

  await openPanel(page);
  await addCollection(page, "Marlowe", "search");
  // A saved search collects its own members, so there is nothing to add by hand and
  // the button that would do it is not offered.
  await expect(page.getByRole("button", { name: "Add The kerb" })).toHaveCount(0);
  await expect(page.getByLabel("Words", { exact: true })).toBeVisible();
});

test("deleting a collection puts the binder back", async ({ page }) => {
  await newProject(page);
  await writeScene(page, "The kerb", "Marlowe put the car in gear.");

  await openPanel(page);
  await addCollection(page, "Marlowe", "search");
  await openPanel(page);
  await page.getByLabel("Showing").selectOption({ label: "Marlowe" });
  await expect(page.getByRole("treeitem")).toHaveCount(0);

  await openPanel(page);
  await page.getByRole("button", { name: "Delete Marlowe", exact: true }).click();
  await page.getByRole("button", { name: "Delete Marlowe", exact: true }).click();

  // The picker is gone with the last collection, and the tree is back rather than the
  // pane being left showing a collection that no longer exists.
  await expect(page.getByLabel("Showing")).toHaveCount(0);
  await expect(row(page, "The kerb")).toBeVisible();
});
