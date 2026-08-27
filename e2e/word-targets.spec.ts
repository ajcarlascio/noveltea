import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "./support/manuscript";

/**
 * Word targets and today's tally, in a real browser and a real replica.
 *
 * No server: the count is summed from the local documents and the targets live in the
 * project row. This is the part of a drafting tool an author looks at every day, and it
 * has to be right on a train.
 */

async function newProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

/**
 * A document called `title` holding `text`, left saved and selected.
 *
 * Renamed as it is made, and not for tidiness: two documents both called "Untitled" are
 * two rows this helper cannot tell apart, and the second write lands on the first
 * document. That reads later as a word count which is simply wrong, with nothing on
 * screen to say why.
 */
async function writeChapter(page: Page, title: string, text: string) {
  await page.getByRole("button", { name: "New document" }).click();
  const fresh = page.getByRole("treeitem").filter({ hasText: "Untitled" });
  await expect(fresh).toHaveCount(1);
  await fresh.click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("treeitem").filter({ hasText: title })).toBeVisible();

  await writeManuscript(page, text);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
}

const strip = (page: Page) => page.getByLabel("Progress");
const openTargets = (page: Page) => page.getByText("Word targets", { exact: true }).click();

test("the strip counts the manuscript as it is written", async ({ page }) => {
  await newProject(page);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("0 words");

  await writeChapter(page, "The stair", "She climbed the stair by lamplight.");
  // Six words, counted from the replica rather than from an event log.
  await expect(strip(page)).toContainText("6 words", { timeout: 10_000 });
});

test("A TARGET TURNS THE COUNT INTO PROGRESS, AND CLEARING IT TURNS IT BACK", async ({ page }) => {
  await newProject(page);
  await writeChapter(page, "The stair", "She climbed the stair by lamplight.");

  await openTargets(page);
  await page.getByLabel("Words in the finished manuscript").fill("100");
  // Saved on leaving the field, so the blur is the write.
  await page.getByLabel("Words a day").click();

  await expect(strip(page)).toContainText("6 of 100");
  // The native element, so it announces itself as a progress bar with no ARIA of its own.
  await expect(strip(page).getByRole("progressbar")).toHaveCount(1);

  // An empty box clears the target rather than storing a zero.
  await page.getByLabel("Words in the finished manuscript").fill("");
  await page.getByLabel("Words a day").click();
  await expect(strip(page)).toContainText("6 words");
  await expect(strip(page).getByRole("progressbar")).toHaveCount(0);
});

test("a target survives the database being reopened", async ({ page }) => {
  await newProject(page);
  await writeChapter(page, "The stair", "She climbed the stair by lamplight.");

  await openTargets(page);
  await page.getByLabel("Words a day").fill("500");
  await page.getByLabel("Words in the finished manuscript").click();
  await expect(strip(page)).toContainText("6 of 500");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  // The only proof it reached the project row rather than React state.
  await expect(strip(page)).toContainText("6 of 500");
});

test("discarding a chapter takes its words back off the count", async ({ page }) => {
  await newProject(page);
  await writeChapter(page, "The stair", "She climbed the stair by lamplight.");
  await writeChapter(page, "The foot", "He waited at the foot of it for hours.");
  await expect(strip(page)).toContainText("15 words", { timeout: 10_000 });

  // The second chapter is selected; discarding it is a reparent, not a delete.
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(strip(page)).toContainText("6 words", { timeout: 10_000 });
});
