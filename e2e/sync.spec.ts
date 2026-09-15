import { expect, test, type Page } from "@playwright/test";

/**
 * Sync in a real browser, against a stubbed server. The engine's behaviour is covered
 * against real SQLite in the unit tests; what these check is that it is reachable,
 * that it never blocks writing, and that its status is ambient rather than modal.
 */
const SERVER = "https://write.example.test";

const sessionBody = JSON.stringify({
  userId: "11111111-1111-1111-1111-111111111111",
  deviceId: "22222222-2222-2222-2222-222222222222",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
});

async function stubRegistration(page: Page) {
  await page.route(`${SERVER}/api/v1/projects`, (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: "{}" }),
  );
}

async function stub(page: Page, sync: object) {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await stubRegistration(page);
  await page.route(`${SERVER}/api/v1/projects/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sync) }),
  );
}

async function openProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Untitled project" })).toBeVisible();
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Server address").fill(SERVER);
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("says a project is device-only until there is an account", async ({ page }) => {
  await openProject(page);
  // Not a warning and not a blocker: writing offline is the supported case.
  await expect(page.getByText(/on this device only/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
});

test("syncs a newly signed-in device without being asked", async ({ page }) => {
  await stub(page, { changes: [], latestId: 0, hasMore: false, resyncRequired: false, syncEpoch: 1 });
  await signIn(page);
  await openProject(page);

  // This replica has never synced this project, so it does not wait out the settle
  // window. That window protects an established replica from spending a flapping
  // connection on a doomed sync — which costs an author nothing, because the work is
  // already local. On a device signed in a minute ago none of that holds: there is no
  // work on it yet, and fifteen minutes of an empty binder is the app doing nothing,
  // visibly, at the one moment somebody is watching for their book to appear.
  //
  // This used to assert "last synced never" and then click the button. The assertion
  // was true and is now false on purpose.
  await expect(page.getByText(/last synced just now/i)).toBeVisible({ timeout: 10_000 });

  // Still offered afterwards: automatic syncing never replaces asking for one.
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
});

test("shows what is waiting to go out", async ({ page }) => {
  await stub(page, { changes: [], latestId: 0, hasMore: false, resyncRequired: false, syncEpoch: 1 });
  await signIn(page);
  await openProject(page);

  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);

  // Ambient status: a count, not a prompt.
  await expect(page.getByText(/1 change waiting/i)).toBeVisible({ timeout: 10_000 });
});

test("keeps writing possible when the server cannot be reached", async ({ page }) => {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await signIn(page);
  await stubRegistration(page);
  await page.route(`${SERVER}/api/v1/projects/**`, (route) => route.abort("connectionrefused"));
  await openProject(page);

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/did not finish/i)).toBeVisible({ timeout: 10_000 });

  // The work is already safe locally, so a failed sync is information, not an
  // emergency — and it must not stop anyone writing.
  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
});

test("applies what the server sends", async ({ page }) => {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await signIn(page);
  await openProject(page);
  const projectId = new URL(page.url()).pathname.split("/").pop()!;

  await stubRegistration(page);
  await page.route(`${SERVER}/api/v1/projects/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        changes: [
          {
            id: 5,
            entityType: "binder_item",
            entityId: "aaaaaaaa-0000-0000-0000-000000000001",
            op: "update",
            data: {
              id: "aaaaaaaa-0000-0000-0000-000000000001",
              project_id: projectId,
              parent_id: null,
              type: "folder",
              title: "Written on another device",
              order_key: "zz",
              version: 1,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          },
        ],
        latestId: 5,
        hasMore: false,
        resyncRequired: false,
        syncEpoch: 1,
      }),
    }),
  );

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("treeitem").filter({ hasText: "Written on another device" })).toBeVisible({
    timeout: 10_000,
  });
});
