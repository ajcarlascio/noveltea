import { expect, test, type Page } from "@playwright/test";

/**
 * Custom metadata, in a real browser and a real replica.
 *
 * No server anywhere in this file, and none is needed: fields and their values are
 * local rows that sync later. An author building a character sheet on a train is doing
 * something the app supports rather than defers.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

/** A document called `title`, selected. */
async function document(page: Page, title: string) {
  await page.getByRole("button", { name: "New document" }).click();
  // The fresh row by name, not `.last()`. The click returns before the write and the
  // re-render behind it, so `.last()` resolves to the *previous* document.
  const fresh = page.getByRole("treeitem").filter({ hasText: "Untitled" });
  await expect(fresh).toHaveCount(1);
  await fresh.click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("treeitem").filter({ hasText: title })).toBeVisible();
}

const openPanel = (page: Page) => page.getByText("Custom fields", { exact: true }).click();

async function addField(page: Page, name: string, kind: string, choices?: string) {
  await page.getByLabel("New field").fill(name);
  await page.getByLabel("Kind of field", { exact: true }).selectOption(kind);
  if (choices !== undefined) await page.getByLabel("Choices", { exact: true }).fill(choices);
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByLabel(`Name of ${name}`)).toHaveValue(name);
}

test("a field an author defines can be answered on an item, and stays answered", async ({ page }) => {
  await newProject(page);
  await document(page, "Marlowe");

  await openPanel(page);
  await addField(page, "Eyes", "text");
  await openPanel(page);

  await page.getByLabel("Eyes", { exact: true }).fill("Grey");
  // Saved on leaving the field, so the blur is the write.
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();
  await expect(page.getByLabel("Eyes", { exact: true })).toHaveValue("Grey");

  // Reopened, which is the only proof the answer reached storage rather than React
  // state. A character sheet that forgets overnight is not a character sheet.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();
  await expect(page.getByLabel("Eyes", { exact: true })).toHaveValue("Grey");
});

test("EACH KIND OF FIELD GETS THE CONTROL ITS KIND DESERVES", async ({ page }) => {
  await newProject(page);
  await document(page, "Marlowe");

  await openPanel(page);
  await addField(page, "Age", "number");
  await addField(page, "Born", "date");
  await addField(page, "Alive", "boolean");
  await addField(page, "Eyes", "select", "Blue, Grey, Hazel");
  await openPanel(page);

  // Native inputs: a date opens the platform's own picker and produces a calendar
  // date, and a number gets the numeric keyboard on a phone.
  await expect(page.getByLabel("Age", { exact: true })).toHaveAttribute("type", "number");
  await expect(page.getByLabel("Born", { exact: true })).toHaveAttribute("type", "date");

  // A yes-or-no is a three-way select, not a checkbox: a checkbox cannot tell "no"
  // from "not asked yet", and for a field added to a whole cast at once that is the
  // difference that matters.
  const alive = page.getByLabel("Alive", { exact: true });
  await expect(alive.getByRole("option")).toHaveText(["Not set", "Yes", "No"]);

  const eyes = page.getByLabel("Eyes", { exact: true });
  await expect(eyes.getByRole("option")).toHaveText(["Not set", "Blue", "Grey", "Hazel"]);
  await eyes.selectOption("Grey");
  await expect(eyes).toHaveValue("Grey");
});

test("clearing an answer takes it away rather than storing an empty one", async ({ page }) => {
  await newProject(page);
  await document(page, "Marlowe");

  await openPanel(page);
  await addField(page, "Age", "number");
  await openPanel(page);

  // The kind-refusals — "soon" in a number, a date that is an instant, a choice not on
  // the list — are pinned in the command tests, not here. Through the interface they
  // are unreachable by construction: a number input takes no letters and a select
  // offers nothing that is not a choice. That is the right place for them to be
  // impossible; this is the case an author can actually reach.
  const age = page.getByLabel("Age", { exact: true });
  await age.fill("42");
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();
  await expect(age).toHaveValue("42");

  await age.fill("");
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();
  await expect(age).toHaveValue("");
});

test("two items answer the same field differently", async ({ page }) => {
  await newProject(page);
  await document(page, "Marlowe");
  await document(page, "Vivian");

  await openPanel(page);
  await addField(page, "Eyes", "text");
  await openPanel(page);

  const eyes = page.getByLabel("Eyes", { exact: true });
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();
  await eyes.fill("Grey");
  await page.getByRole("treeitem").filter({ hasText: "Vivian" }).click();
  await expect(eyes).toHaveValue("");

  await eyes.fill("Blue");
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();
  await expect(eyes).toHaveValue("Grey");
  await page.getByRole("treeitem").filter({ hasText: "Vivian" }).click();
  await expect(eyes).toHaveValue("Blue");
});

test("deleting a field takes it off every item at once", async ({ page }) => {
  await newProject(page);
  await document(page, "Marlowe");

  await openPanel(page);
  await addField(page, "Eyes", "text");
  await openPanel(page);
  await page.getByLabel("Eyes", { exact: true }).fill("Grey");
  await page.getByRole("treeitem").filter({ hasText: "Marlowe" }).click();

  // Asserted present first, or the disappearance below proves only that the locator
  // never matched anything.
  await expect(page.getByLabel("Details")).toBeVisible();

  await openPanel(page);
  await page.getByRole("button", { name: "Delete Eyes", exact: true }).click();
  await page.getByRole("button", { name: "Delete Eyes", exact: true }).click();

  // The whole details row goes with the last field, rather than leaving an empty
  // strip above the manuscript.
  await expect(page.getByLabel("Eyes", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Details")).toHaveCount(0);
});

test("a project the author never customises shows no details row at all", async ({ page }) => {
  await newProject(page);
  await document(page, "Marlowe");
  // Most projects never want a character sheet, and should not pay for one in
  // manuscript height.
  await expect(page.getByLabel("Details")).toHaveCount(0);
});
