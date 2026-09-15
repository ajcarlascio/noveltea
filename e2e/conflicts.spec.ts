import { expect, test, type Page } from "@playwright/test";

/**
 * Reconciling a conflict, in a real browser against a stubbed server.
 *
 * A conflict is the one thing in this app that genuinely needs a person: the server
 * never merges prose, so both versions sit there until an author decides. What these
 * check is that the decision is reachable, that neither version is lost on the way to
 * it, and that a merge interrupted by a third device does not throw away the merge.
 */
const SERVER = "https://write.example.test";

const sessionBody = JSON.stringify({
  userId: "11111111-1111-1111-1111-111111111111",
  deviceId: "22222222-2222-2222-2222-222222222222",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
});

const COPY_ID = "cccccccc-0000-0000-0000-000000000001";
const ORIGINAL_ID = "dddddddd-0000-0000-0000-000000000001";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const SUMMARY = {
  copyId: COPY_ID,
  originalId: ORIGINAL_ID,
  originalTitle: "The lighthouse",
  copyTitle: "The lighthouse (Conflicted Copy, Phone, 2026-08-18)",
  forkedFromVersion: 3,
  originalVersion: 5,
  forkedAt: "2026-08-18T09:00:00Z",
};

const DETAIL = {
  ...SUMMARY,
  originalContent: doc("She climbed the stair by lamplight."),
  copyContent: doc("She climbed the stair in the dark."),
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** Registered in order, and Playwright gives precedence to the most recent match. */
async function stubServer(page: Page, options: { conflicts?: unknown[]; resolve?: () => object } = {}) {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await page.route(`${SERVER}/api/v1/projects`, (route) =>
    route.fulfill(json({}, 201)),
  );
  await page.route(`${SERVER}/api/v1/projects/**`, (route) =>
    route.fulfill(json({ changes: [], latestId: 0, hasMore: false, resyncRequired: false, syncEpoch: 1 })),
  );
  await page.route(`${SERVER}/api/v1/projects/*/conflicts`, (route) =>
    route.fulfill(json(options.conflicts ?? [])),
  );
  await page.route(`${SERVER}/api/v1/conflicts/*`, (route) => route.fulfill(json(DETAIL)));
  await page.route(`${SERVER}/api/v1/conflicts/*/resolve`, (route) =>
    route.fulfill(options.resolve ? options.resolve() : json({ resolved: true })),
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

test("says nothing at all when there is nothing to reconcile", async ({ page }) => {
  await stubServer(page);
  await signIn(page);
  await openProject(page);

  // The panel is an interruption by design, so it must not appear on a quiet project.
  await expect(page.getByRole("region", { name: "Conflicts" })).toHaveCount(0);
});

test("surfaces a conflict and carries both versions into the merge", async ({ page }) => {
  await stubServer(page, { conflicts: [SUMMARY] });
  await signIn(page);
  await openProject(page);

  await expect(page.getByText(/one document needs your attention/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Review" }).click();

  const merge = page.getByRole("region", { name: "Resolve a conflict" });
  await expect(merge).toBeVisible();
  await expect(merge.getByText("She climbed the stair by lamplight.")).toBeVisible();
  await expect(merge.getByText("She climbed the stair in the dark.")).toBeVisible();

  // Nothing is written until a starting point is chosen — there is no default, because
  // guessing which version an author wants is exactly the thing the server refuses to do.
  await expect(merge.getByRole("button", { name: "Resolve" })).toBeDisabled();
});

test("writes the merged text back, with the original's version to check against", async ({ page }) => {
  const posted: string[] = [];
  await stubServer(page, { conflicts: [SUMMARY] });
  await page.route(`${SERVER}/api/v1/conflicts/*/resolve`, (route) => {
    posted.push(route.request().postData() ?? "");
    return route.fulfill(json({ resolved: true }));
  });
  await signIn(page);
  await openProject(page);

  await page.getByRole("button", { name: "Review" }).click();
  const merge = page.getByRole("region", { name: "Resolve a conflict" });
  await merge
    .getByRole("article")
    .filter({ hasText: "The conflicting copy" })
    .getByRole("button", { name: "Start from this" })
    .click();

  const result = merge.getByRole("textbox", { name: "Merged version" });
  await expect(result).toContainText("She climbed the stair in the dark.");
  await result.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A gull cried.");

  await merge.getByRole("button", { name: "Resolve" }).click();

  // The list is refetched afterwards and the stub still answers with the same
  // conflict, so the panel returning is expected; what matters is what went out.
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  const body = JSON.parse(posted[0] ?? "{}") as { baseVersion: number; content: { type: string } };
  expect(body.baseVersion).toBe(5);
  expect(JSON.stringify(body.content)).toContain("A gull cried.");
});

test("keeps the merge on screen when another device moved the document first", async ({ page }) => {
  await stubServer(page, {
    conflicts: [SUMMARY],
    resolve: () => json({ code: "stale_original", message: "stale" }, 409),
  });
  await signIn(page);
  await openProject(page);

  await page.getByRole("button", { name: "Review" }).click();
  const merge = page.getByRole("region", { name: "Resolve a conflict" });
  await merge
    .getByRole("article")
    .filter({ hasText: "On the server" })
    .getByRole("button", { name: "Start from this" })
    .click();
  await merge.getByRole("button", { name: "Resolve" }).click();

  await expect(merge.getByRole("alert")).toContainText(/changed on another device/i);
  // Closing here would discard work the author just did by hand. Both texts stay put.
  await expect(merge).toBeVisible();
  await expect(merge.getByRole("textbox", { name: "Merged version" })).toContainText(
    "She climbed the stair by lamplight.",
  );
});

test("marks a conflict copy in the binder so it is not mistaken for a chapter", async ({ page }) => {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await page.route(`${SERVER}/api/v1/projects`, (route) => route.fulfill(json({}, 201)));
  await page.route(`${SERVER}/api/v1/projects/*/conflicts`, (route) => route.fulfill(json([])));
  await signIn(page);
  await openProject(page);
  const projectId = new URL(page.url()).pathname.split("/").pop()!;

  const row = (id: string, title: string, extra: object) => ({
    id: id === ORIGINAL_ID ? 6 : 7,
    entityType: "binder_item",
    entityId: id,
    op: "update",
    data: {
      id,
      project_id: projectId,
      parent_id: null,
      type: "document",
      title,
      order_key: id === ORIGINAL_ID ? "zy" : "zz",
      version: 1,
      created_at: "2026-08-18T09:00:00Z",
      updated_at: "2026-08-18T09:00:00Z",
      ...extra,
    },
  });

  await page.route(`${SERVER}/api/v1/projects/*/sync*`, (route) =>
    route.fulfill(
      json({
        changes: [
          row(ORIGINAL_ID, "The lighthouse", {}),
          row(COPY_ID, "The lighthouse (Conflicted Copy, Phone)", {
            conflict_of_id: ORIGINAL_ID,
            conflict_base_version: 3,
          }),
        ],
        latestId: 7,
        hasMore: false,
        resyncRequired: false,
        syncEpoch: 1,
      }),
    ),
  );

  await page.getByRole("button", { name: "Sync now" }).click();

  const copy = page.getByRole("treeitem").filter({ hasText: "Conflicted Copy" });
  await expect(copy).toBeVisible({ timeout: 10_000 });
  // Matched on the badge's tooltip, not on its text: the generated title contains the
  // word "conflicted" too, so a text match would pass with the badge removed.
  const badge = page.getByTitle("A conflicting version of another document");
  await expect(badge).toHaveCount(1);
  await expect(copy.getByTitle("A conflicting version of another document")).toBeVisible();
});
