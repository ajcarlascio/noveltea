import { expect, test, type Page } from "@playwright/test";

/**
 * Compile: what will be exported, where it goes, and what this edition cannot do.
 *
 * The pre-flight is computed on the device from the local replica, so it is asserted
 * here with no compile route stubbed at all — if it needed the server it would not be
 * a pre-flight.
 */
const SERVER = "https://write.example.test";

const sessionBody = JSON.stringify({
  userId: "11111111-1111-1111-1111-111111111111",
  deviceId: "22222222-2222-2222-2222-222222222222",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
});

const FORMATS = {
  supported: ["txt", "md", "html"],
  unavailable: ["rtf", "docx", "odt", "epub", "pdf"],
  destinations: ["download", "server"],
  unavailableDestinations: ["cloud"],
};

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
  // Registered after the catch-all above: Playwright gives precedence to the most
  // recently added matching route, so the specific one has to come second.
  await page.route(`${SERVER}/api/v1/projects/*/compile/formats`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FORMATS) }),
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

async function writeChapter(page: Page, text: string) {
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByRole("treeitem").last().click();
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await surface.click({ position: { x: 12, y: 12 } });
  await surface.fill(text);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
}

const openCompile = (page: Page) => page.getByText("Compile and trash").click();

test("counts what would be exported before anything is sent", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "She climbed the stair by lamplight.");

  await openCompile(page);
  // Six words, one document — worked out on the device.
  await expect(page.getByText(/1 document, 6 words/i)).toBeVisible({ timeout: 10_000 });
});

test("WARNS ABOUT FOLDERS, EMPTY DOCUMENTS AND THE TRASH BEFORE COMPILING", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);

  await writeChapter(page, "She climbed the stair by lamplight.");
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(3);

  // A discarded scene, trashed rather than deleted.
  await writeChapter(page, "Words nobody wants published.");
  await page.getByRole("button", { name: "Move to trash" }).click();

  await openCompile(page);
  await expect(page.getByText(/folder holds no text/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/document has no text yet/i)).toBeVisible();
  await expect(page.getByText(/in the trash and will not be included/i)).toBeVisible();
  await expect(page.getByText(/synopses and notes are never exported/i)).toHaveCount(0);
});

test("offers the destinations this edition has, and names the one it does not", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "prose enough to export");
  await openCompile(page);

  const where = page.getByLabel("Put it");
  await expect(where).toBeVisible({ timeout: 10_000 });

  // Asserted on the attribute rather than through toBeDisabled, which does not report
  // an <option> as disabled here. The attribute is the thing that makes it unselectable,
  // so it is also the thing worth asserting.
  await expect(where.getByRole("option", { name: "Download to this device" })).not.toHaveAttribute(
    "disabled",
    "",
  );
  await expect(where.getByRole("option", { name: "Keep on the server" })).not.toHaveAttribute(
    "disabled",
    "",
  );
  // Shown and disabled, never hidden: a destination this build lacks is an upgrade,
  // and omitting it would claim the software cannot do something it can.
  await expect(where.getByRole("option", { name: /Cloud storage/ })).toHaveAttribute("disabled", "");
});

test("says what each format does about page layout, and does not overclaim", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "prose enough to export");
  await openCompile(page);

  const format = page.getByLabel("Format");
  await expect(format).toBeVisible({ timeout: 10_000 });

  // Markdown is the default. It has no page, so the note must say so rather than
  // reassure — the export really does carry no manuscript formatting.
  await expect(page.getByText(/Markdown carries no page layout/)).toBeVisible();

  await format.selectOption("html");
  // Standard manuscript format is a real convention with a real definition, so the
  // note names the parts of it an author would otherwise go and set by hand.
  const note = page.getByText(/Standard manuscript format/);
  await expect(note).toBeVisible();
  await expect(note).toContainText("double-spaced");
  await expect(note).toContainText("one-inch margins");
  await expect(page.getByText(/Markdown carries no page layout/)).toBeHidden();

  await format.selectOption("txt");
  await expect(page.getByText(/Plain text carries no page layout/)).toBeVisible();
  await expect(page.getByText(/Standard manuscript format/)).toBeHidden();
});

test("submits the destination the author chose", async ({ page }) => {
  const posted: string[] = [];
  await stub(page);
  await page.route(`${SERVER}/api/v1/projects/*/compile`, (route) => {
    posted.push(route.request().postData() ?? "");
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ id: "job-1", status: "queued" }),
    });
  });
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "prose enough to export");
  await openCompile(page);

  await page.getByLabel("Put it").selectOption("server");
  await page.getByRole("button", { name: "Compile" }).click();

  await expect.poll(() => posted.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(JSON.parse(posted[0] ?? "{}")).toMatchObject({ destination: "server" });
});

test("will not compile a project with nothing in it", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await openCompile(page);

  await expect(page.getByText(/nothing would be exported/i)).toBeVisible({ timeout: 10_000 });
  // Sending it would cost a round trip and a wait to be told the same thing.
  await expect(page.getByRole("button", { name: "Compile" })).toBeDisabled();
});
