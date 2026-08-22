import { expect, test, type Page } from "@playwright/test";

const SERVER = "https://write.example.test";
const sessionBody = JSON.stringify({
  userId: "11111111-1111-1111-1111-111111111111",
  deviceId: "22222222-2222-2222-2222-222222222222",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
});

async function writeSomething(page: Page) {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("treeitem").first().click();

  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click();
  await surface.pressSequentially("The lighthouse kept its own hours.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 5000 });
}

test("finds a document by a word in its body, with no server", async ({ page }) => {
  const outbound: string[] = [];
  await page.route("**://*/**", (route) => {
    const url = route.request().url();
    if (!url.startsWith("http://127.0.0.1:4173")) outbound.push(url);
    return route.continue();
  });

  await writeSomething(page);
  await page.getByRole("searchbox", { name: "Search" }).fill("lighthouse");

  await expect(page.getByRole("button", { name: /Untitled/ })).toBeVisible({ timeout: 10_000 });
  // The entire index is on the device. This works on a plane.
  expect(outbound).toEqual([]);
});

test("says so plainly when nothing matches", async ({ page }) => {
  await writeSomething(page);
  await page.getByRole("searchbox", { name: "Search" }).fill("submarine");
  await expect(page.getByText(/nothing matches/i)).toBeVisible({ timeout: 10_000 });
});

test("does not crash on a search FTS5 would refuse", async ({ page }) => {
  await writeSomething(page);
  // A stray quote is a syntax error to FTS5, and would reach an author mid-word.
  await page.getByRole("searchbox", { name: "Search" }).fill('the "lighthouse');
  await expect(page.getByRole("button", { name: /Untitled/ })).toBeVisible({ timeout: 10_000 });
});

test("asks for an account before compiling, and says why", async ({ page }) => {
  await writeSomething(page);
  await page.getByText("Compile and trash").click();
  // The export pipeline is on the server. Everything else works without one, so this
  // explains itself rather than appearing broken.
  await expect(page.getByText(/compiling happens on your server/i)).toBeVisible();
});

test("compiles and offers the finished file", async ({ page }) => {
  await page.route(`${SERVER}/api/v1/auth/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );
  await page.goto("/signin");
  await page.getByLabel("Server address").fill(SERVER);
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.route(`${SERVER}/api/v1/projects/*/compile/formats`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ supported: ["txt", "md", "html"], unavailable: ["docx", "pdf"] }),
    }),
  );
  await page.route(`${SERVER}/api/v1/projects/*/compile`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "job-1" }) }),
  );
  await page.route(`${SERVER}/api/v1/compile-jobs/job-1`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-1", format: "md", destination: "download", status: "done",
        outputFilename: "book.md", outputBytes: 42, wordCount: 6,
      }),
    }),
  );
  await page.route(`${SERVER}/api/v1/projects/*/sync**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ changes: [], latestId: 0, hasMore: false, resyncRequired: false, syncEpoch: 1 }),
    }),
  );

  await writeSomething(page);

  // Compile sits behind a fold: it is occasional, and the manuscript is not.
  await page.getByText("Compile and trash").click();

  // Unavailable formats are listed and disabled, not hidden: this is open core, and
  // an omitted format would claim the software cannot do something it can.
  await expect(page.getByRole("option", { name: /not in this edition/ }).first()).toBeAttached();

  await page.getByRole("button", { name: "Compile", exact: true }).click();
  await expect(page.getByRole("button", { name: /Download book\.md/ })).toBeVisible({ timeout: 20_000 });
});
