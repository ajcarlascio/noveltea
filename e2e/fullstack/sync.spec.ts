import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "../support/manuscript";

/**
 * Two devices, one real account, a real API and Postgres. Each browser context has its
 * own OPFS, so the second one is a genuinely fresh device: anything it ends up holding
 * came over the wire.
 */
const EMAIL = "admin@localhost";
const PASSWORD = "fullstack-admin-pw"; // deploy/fullstack.compose.yml

async function signIn(page: Page, server: string) {
  await page.goto("/signin");
  await page.getByLabel("Server address").fill(server);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
}

/** Presses "Sync now" the way an author would, and waits until nothing is left to send. */
async function syncNow(page: Page) {
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const button = page.getByRole("button", { name: "Sync now" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText(/last synced just now/i)).toBeVisible();
  await expect(page.getByText(/changes? waiting/i)).toHaveCount(0);
  await expect(page.getByText(/did not finish/i)).toHaveCount(0);
}

test("a second device receives the account's work, and edits travel both ways", async ({ browser, baseURL }) => {
  const server = baseURL!;
  const run = Date.now().toString(36);
  const fromA = `Written on device A ${run}.`;
  const fromB = `Answered from device B ${run}.`;

  // --- Device A: create, write, sync -------------------------------------------------
  const a = await (await browser.newContext()).newPage();
  await signIn(a, server);
  await ready(a, "/projects");
  await a.getByRole("button", { name: "New project" }).click();
  await a.getByRole("link", { name: "Untitled project" }).first().click();
  // The project's own title is not editable from here; the id is what ties devices
  // together, and "Untitled project" is what the other device will list.
  await expect(a.getByRole("heading", { name: "Untitled project" })).toBeVisible();
  await a.getByRole("button", { name: "New document" }).click();
  await a.getByRole("treeitem").first().click();
  await writeManuscript(a, fromA);
  await syncNow(a);
  const projectUrl = a.url();

  // --- Device B: fresh OPFS, same account --------------------------------------------
  const b = await (await browser.newContext()).newPage();
  await signIn(b, server);
  await ready(b, "/projects");
  // The regression this test exists for: nothing local, so the project can only appear
  // if the client asks the server what the account has.
  await b.getByRole("link", { name: "Untitled project" }).first().click({ timeout: 30_000 });
  await expect(b).toHaveURL(projectUrl);
  await b.getByRole("treeitem").first().click();
  await expect(b.getByRole("textbox", { name: "Manuscript" })).toHaveText(fromA);

  // --- B edits, A receives -----------------------------------------------------------
  await writeManuscript(b, fromB);
  await syncNow(b);

  await syncNow(a);
  await a.reload();
  await expect(a.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await a.getByRole("treeitem").first().click();
  await expect(a.getByRole("textbox", { name: "Manuscript" })).toHaveText(fromB);
});
