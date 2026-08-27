import { expect, test, type Page } from "@playwright/test";

/**
 * Labels and statuses, in a real browser and a real replica.
 *
 * No server is stubbed. Nothing here is allowed to need one: a label is part of how a
 * book is organised, and an author on a train who cannot mark a scene as drafted has
 * lost the feature, not deferred it.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole("treeitem").filter({ hasText: name });

const openPanel = (page: Page) => page.getByText("Labels and statuses").click();

async function addTerm(page: Page, kind: "label" | "status", name: string) {
  await page.getByLabel(kind === "label" ? "New label" : "New status").fill(name);
  // Named for its kind, because there are two of them.
  await page.getByRole("button", { name: kind === "label" ? "Add label" : "Add status" }).click();
  await expect(page.getByLabel(`Name of ${name}`)).toHaveValue(name);
}

test("marks a document with a label and a status, and shows both in the binder", async ({
  page,
}) => {
  await newProject(page);
  await openPanel(page);
  await addTerm(page, "label", "Bob's POV");
  await addTerm(page, "status", "First draft");

  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();

  await page.getByLabel("Label", { exact: true }).selectOption({ label: "Bob's POV" });
  await page.getByLabel("Status", { exact: true }).selectOption({ label: "First draft" });

  // The tree is where an author actually reads these back.
  await expect(row(page, "Untitled")).toContainText("Bob's POV");
  await expect(row(page, "Untitled")).toContainText("First draft");

  // And they survive the database being reopened, which is the only proof the write
  // reached storage rather than React state.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await expect(row(page, "Untitled")).toContainText("Bob's POV");
  await expect(row(page, "Untitled")).toContainText("First draft");
});

test("SETTING A LABEL DOES NOT CLEAR THE STATUS BESIDE IT", async ({ page }) => {
  await newProject(page);
  await openPanel(page);
  await addTerm(page, "label", "Bob's POV");
  await addTerm(page, "label", "Ada's POV");
  await addTerm(page, "status", "First draft");

  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();
  await page.getByLabel("Status", { exact: true }).selectOption({ label: "First draft" });
  await page.getByLabel("Label", { exact: true }).selectOption({ label: "Bob's POV" });

  // Changing the label a second time is the case that would expose a write sending
  // both columns from a stale copy of the row.
  await page.getByLabel("Label", { exact: true }).selectOption({ label: "Ada's POV" });

  await expect(row(page, "Untitled")).toContainText("Ada's POV");
  await expect(row(page, "Untitled")).toContainText("First draft");
});

test("deleting a label takes it off the documents wearing it", async ({ page }) => {
  await newProject(page);
  await openPanel(page);
  await addTerm(page, "label", "Bob's POV");

  await page.getByRole("button", { name: "New document" }).click();
  await row(page, "Untitled").click();
  await page.getByLabel("Label", { exact: true }).selectOption({ label: "Bob's POV" });
  await expect(row(page, "Untitled")).toContainText("Bob's POV");

  // Asked twice: this is the one gesture in the panel that changes items elsewhere.
  await page.getByRole("button", { name: "Delete Bob's POV", exact: true }).click();
  await page.getByRole("button", { name: "Delete Bob's POV everywhere" }).click();

  await expect(row(page, "Untitled")).not.toContainText("Bob's POV");
  await expect(page.getByLabel("Label", { exact: true })).toHaveValue("");
});

test("refuses two labels with the same name, and says so", async ({ page }) => {
  await newProject(page);
  await openPanel(page);
  await addTerm(page, "label", "Bob's POV");

  await page.getByLabel("New label").fill("Bob's POV");
  await page.getByRole("button", { name: "Add label" }).click();

  await expect(page.getByRole("alert")).toContainText(/already a label/i);
});
