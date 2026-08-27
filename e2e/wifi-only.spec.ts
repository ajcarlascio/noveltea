import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "./support/manuscript";

/**
 * Holding syncs for Wi-Fi, in a real browser.
 *
 * `navigator.connection` is Chromium-only and reports no bearer on desktop, so the
 * connection is stubbed in the page before the app loads. That is the honest way to
 * test this: the alternative is asserting the code path that says "this browser will
 * not tell me", which is the case that already happens by default.
 */
const SERVER = "https://write.example.test";

const sessionBody = JSON.stringify({
  userId: "11111111-1111-1111-1111-111111111111",
  deviceId: "22222222-2222-2222-2222-222222222222",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
});

/** Installed before any app code runs, so the first read already sees it. */
async function fakeConnection(page: Page, connection: Record<string, unknown> | null) {
  await page.addInitScript((value) => {
    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      get: () => value,
    });
  }, connection);
}

async function stub(page: Page) {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await page.route(`${SERVER}/api/v1/projects/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ changes: [], latestId: 0, hasMore: false, resyncRequired: false, syncEpoch: 1 }),
    }),
  );
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Server address").fill(SERVER);
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function openProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

const holdForWifi = async (page: Page) => {
  await page.goto("/settings");
  await page.getByLabel("Hold automatic syncs for Wi-Fi").check();
};

test("says when it cannot tell what the connection is", async ({ page }) => {
  await fakeConnection(page, null);
  await page.goto("/settings");
  // A setting that silently does nothing is worse than one that explains when it can.
  await expect(page.getByText(/will not say what kind of connection/i)).toBeVisible();
});

test("names a mobile connection and offers the setting", async ({ page }) => {
  await fakeConnection(page, { type: "cellular" });
  await stub(page);
  await signIn(page);
  await openProject(page);

  await expect(page.getByText(/looks like mobile data/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Settings" }).last()).toBeVisible();
});

test("says nothing about data on a connection that costs nothing", async ({ page }) => {
  await fakeConnection(page, { type: "wifi" });
  await stub(page);
  await signIn(page);
  await openProject(page);

  await expect(page.getByText(/last synced/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/looks like mobile data/i)).toHaveCount(0);
  await expect(page.getByText(/waiting for wi-fi/i)).toHaveCount(0);
});

test("HOLDS CHANGES ON MOBILE DATA AND SAYS SO", async ({ page }) => {
  await fakeConnection(page, { type: "cellular" });
  await stub(page);
  await signIn(page);
  await holdForWifi(page);
  await openProject(page);

  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);

  // Ambient, not an error: the work is already safe on the device, and this only
  // explains why the count is not going down.
  await expect(page.getByText(/waiting for wi-fi/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/looks like mobile data/i)).toHaveCount(0);
});

test("sync now sends anyway, because asking for it is the consent", async ({ page }) => {
  await fakeConnection(page, { type: "cellular" });
  await stub(page);
  await signIn(page);
  await holdForWifi(page);
  await openProject(page);

  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByText(/waiting for wi-fi/i)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/last synced just now/i)).toBeVisible({ timeout: 10_000 });
});

test("keeps writing possible while syncs are held", async ({ page }) => {
  await fakeConnection(page, { type: "cellular" });
  await stub(page);
  await signIn(page);
  await holdForWifi(page);
  await openProject(page);

  // The whole premise: holding a sync delays the copy on the server and nothing else.
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByRole("treeitem").last().click();
  await writeManuscript(page, "She climbed the stair by lamplight.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
});
