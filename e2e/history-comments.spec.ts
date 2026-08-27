import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "./support/manuscript";

/**
 * Revision history and margin comments, in a real browser.
 *
 * Both read and write the local replica only — no server is stubbed here, because
 * neither feature is allowed to need one. What these check is that the history can be
 * reached and restored from, and that a comment whose passage has been rewritten says
 * so instead of quietly pointing somewhere else.
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

/**
 * Replaces the manuscript with `text` and waits for it to be saved.
 *
 * The replacement itself is `writeManuscript`, which every spec that rewrites a
 * document shares — see the note there for why it is retried. The wait is this
 * file's own: an orphaning test that silently appended instead of replacing passed
 * for the wrong reason, the quotation still being right there.
 */
async function write(page: Page, text: string) {
  await writeManuscript(page, text);
  // The editor's own status, not any text reading "Saved": the history list carries
  // an "Autosaved" label and getByText matches substrings inside hidden details too.
  await expect(page.locator('[data-state="clean"]')).toBeVisible({ timeout: 10_000 });
}

test("keeps a named version and puts it back", async ({ page }) => {
  await openDocument(page);
  await write(page, "She climbed the stair by lamplight.");

  await page.getByText("History", { exact: false }).first().click();
  await page.getByLabel("Save this version as").fill("The first draft");
  await page.getByRole("button", { name: "Save a version" }).click();
  await expect(page.getByText("The first draft")).toBeVisible({ timeout: 10_000 });

  await write(page, "She climbed the stair in the dark.");
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toContainText("in the dark");

  await page.getByRole("button", { name: "Restore The first draft" }).click();
  // Replacing everything on screen asks first, and says the current state is kept.
  await expect(page.getByText(/kept too, so this can be undone/i)).toBeVisible();
  await page.getByRole("button", { name: "Replace the document" }).click();

  await expect(page.getByRole("textbox", { name: "Manuscript" })).toContainText("by lamplight", {
    timeout: 10_000,
  });
});

test("a restore is itself undoable", async ({ page }) => {
  await openDocument(page);
  await write(page, "the original");
  await page.getByText("History", { exact: false }).first().click();
  await page.getByLabel("Save this version as").fill("Mark");
  await page.getByRole("button", { name: "Save a version" }).click();
  await expect(page.getByText("Mark")).toBeVisible({ timeout: 10_000 });

  await write(page, "the newer words");
  await page.getByRole("button", { name: "Restore Mark" }).click();
  await page.getByRole("button", { name: "Replace the document" }).click();
  await expect(page.getByRole("textbox", { name: "Manuscript" })).toContainText("the original", {
    timeout: 10_000,
  });

  // An author who reverts to the wrong draft has not lost the newer one.
  await expect(page.getByText("Before restore")).toBeVisible();
});

test("anchors a comment to the selected words and shows the quotation", async ({ page }) => {
  await openDocument(page);
  await write(page, "The lighthouse kept its own hours.");

  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click({ position: { x: 12, y: 12 } });
  await page.keyboard.press("ControlOrMeta+a");

  await page.getByText("Comments", { exact: false }).first().click();
  await page.getByLabel("New comment").fill("is this too slow?");
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const thread = page.getByRole("listitem").filter({ hasText: "is this too slow?" });
  await expect(thread).toBeVisible({ timeout: 10_000 });
  await expect(thread.getByRole("blockquote")).toContainText("The lighthouse kept its own hours.");
});

test("SAYS SO WHEN THE PASSAGE A COMMENT WAS ABOUT IS GONE", async ({ page }) => {
  await openDocument(page);
  await write(page, "The lighthouse kept its own hours.");

  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click({ position: { x: 12, y: 12 } });
  await page.keyboard.press("ControlOrMeta+a");

  await page.getByText("Comments", { exact: false }).first().click();
  await page.getByLabel("New comment").fill("is this too slow?");
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const thread = page.getByRole("listitem").filter({ hasText: "is this too slow?" });
  await expect(thread).toBeVisible({ timeout: 10_000 });
  await expect(thread.getByText(/text this was about has changed/i)).toHaveCount(0);

  // Rewriting the quoted passage away must not move the note to whatever now sits at
  // those offsets, and must not delete it either.
  await write(page, "An entirely different opening.");

  await expect(thread.getByText(/text this was about has changed/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(thread).toContainText("is this too slow?");
  await expect(thread.getByRole("blockquote")).toContainText("The lighthouse kept its own hours.");
});

test("resolves and reopens a thread", async ({ page }) => {
  await openDocument(page);
  await write(page, "prose to talk about");

  await page.getByText("Comments", { exact: false }).first().click();
  await page.getByLabel("New comment").fill("a general thought");
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const thread = page.getByRole("listitem").filter({ hasText: "a general thought" });
  await expect(thread).toBeVisible({ timeout: 10_000 });
  await thread.getByRole("button", { name: "Resolve" }).click();

  // Resolved threads leave the list, and the count with them.
  await expect(page.getByRole("listitem").filter({ hasText: "a general thought" })).toHaveCount(0, {
    timeout: 10_000,
  });

  await page.getByLabel("Show resolved").check();
  const reopened = page.getByRole("listitem").filter({ hasText: "a general thought" });
  await expect(reopened).toBeVisible();
  await reopened.getByRole("button", { name: "Reopen" }).click();
  await expect(reopened.getByRole("button", { name: "Resolve" })).toBeVisible({ timeout: 10_000 });
});

test("replies stay inside their thread", async ({ page }) => {
  await openDocument(page);
  await write(page, "prose to talk about");

  await page.getByText("Comments", { exact: false }).first().click();
  await page.getByLabel("New comment").fill("what do you think?");
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const thread = page.getByRole("listitem").filter({ hasText: "what do you think?" });
  await expect(thread).toBeVisible({ timeout: 10_000 });
  await thread.getByRole("button", { name: "Reply" }).click();
  await thread.getByLabel("Reply").fill("I think it holds");
  await thread.getByRole("button", { name: "Send" }).click();

  await expect(thread).toContainText("I think it holds", { timeout: 10_000 });
  // One thread, not two: a reply is not a new conversation.
  await expect(page.getByRole("listitem").filter({ hasText: "what do you think?" })).toHaveCount(1);
});
