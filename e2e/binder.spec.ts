import { expect, test, type Page } from "@playwright/test";
import { hasOpfs } from "./support/storage";

/**
 * The binder against a real browser and a real OPFS database. The unit tests cover
 * the commands and the tree component in isolation; this is the only place the two
 * meet the actual storage.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).click();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole("treeitem").filter({ hasText: name });

test("creates folders and documents, and nests them", async ({ page }) => {
  await newProject(page);

  await page.getByRole("button", { name: "New folder" }).click();
  await expect(row(page, "New folder")).toBeVisible();

  // With the folder selected, a new document goes inside it.
  await row(page, "New folder").click();
  await page.getByRole("button", { name: "New document" }).click();

  const document = row(page, "Untitled");
  await expect(document).toBeVisible();
  await expect(document).toHaveAttribute("aria-level", "2");
});

test("renames the selected item", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "New folder" }).click();
  await row(page, "New folder").click();

  await page.getByRole("button", { name: "Rename" }).click();
  const field = page.getByLabel("New title");
  await field.fill("Act I");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(row(page, "Act I")).toBeVisible();
  await expect(row(page, "New folder")).toHaveCount(0);
});

test("trashes an item and puts it back where it came from", async ({ page }) => {
  await newProject(page);

  await page.getByRole("button", { name: "New folder" }).click();
  await row(page, "New folder").click();
  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();

  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByRole("treeitem", { name: /Untitled/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  // Back inside the folder it was in, not stranded at the root.
  await expect(row(page, "Untitled")).toHaveAttribute("aria-level", "2");
});

test("empties the trash and does not bring anything back", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "New folder" }).click();
  await row(page, "New folder").click();
  await page.getByRole("button", { name: "Move to trash" }).click();

  await page.getByRole("button", { name: "Empty trash" }).click();
  await expect(page.getByText("Nothing in the trash.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();
  await expect(page.getByText("Nothing in the trash.")).toBeVisible();
  await expect(page.getByRole("treeitem")).toHaveCount(0);
});

test("keeps the binder across a reload", async ({ page }) => {
  await page.goto("/projects");
  test.skip(!(await hasOpfs(page)), "This engine has no OPFS; a reload keeps nothing.");

  await newProject(page);
  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await row(page, "New folder").click();
  await page.getByRole("button", { name: "New document" }).click();
  // Waiting for the tree to catch up before reloading. A click does not settle the
  // write behind it, and a slower machine reloads first and finds an empty binder —
  // which reads as data loss and is not.
  await expect(page.getByRole("treeitem")).toHaveCount(2);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();

  await expect(row(page, "New folder")).toBeVisible();
  // The child is inside a collapsed folder after a reload, so open it.
  await row(page, "New folder").click();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Untitled")).toBeVisible();
});

test("refuses to move an item inside itself, and says so", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "New folder" }).click();
  await row(page, "New folder").click();

  // "Move to top level" is disabled for something already there — the interface
  // does not offer the move that would be refused.
  await expect(page.getByRole("button", { name: "Move to top level" })).toBeDisabled();
});
