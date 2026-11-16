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
  // "Last synced just now" stays true for a minute after any earlier sync, so it cannot
  // prove THIS one finished. "Syncing…" can come and go faster than a poll, so a
  // MutationObserver latches it, and we wait for it to have appeared and gone.
  await page.evaluate(() => {
    const w = window as unknown as { __syncSeen: boolean };
    w.__syncSeen = false;
    const look = () => {
      if (document.body.textContent.includes("Syncing…")) w.__syncSeen = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    look();
  });
  await button.click();
  await page.waitForFunction(() => (window as unknown as { __syncSeen: boolean }).__syncSeen);
  await expect(page.getByText("Syncing…")).toHaveCount(0);
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
  // The title is not editable from here, so the other device finds the project by id.
  await expect(a.getByRole("heading", { name: "Untitled project" })).toBeVisible();
  const projectPath = new URL(a.url()).pathname;
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
  await b.locator(`a[href="${projectPath}"]`).click({ timeout: 30_000 });
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
