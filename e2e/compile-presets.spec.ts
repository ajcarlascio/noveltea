import { expect, test, type Page } from "@playwright/test";
import { writeManuscript } from "./support/manuscript";

/**
 * Compile presets, in a real browser and a real replica.
 *
 * A preset is a saved submission format — the export format and which chapters go into
 * it — so that an author sending the first three chapters to an agent does not rebuild
 * that selection every time. Making one is entirely local; only the compile it feeds
 * needs a server.
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
  // Registered after the catch-all: Playwright prefers the most recently added match.
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

/** A document called `title` holding `text`, left saved. */
async function writeChapter(page: Page, title: string, text: string) {
  await page.getByRole("button", { name: "New document" }).click();
  // The fresh row by name, not `.last()`. The click returns before the write and the
  // re-render behind it, so `.last()` resolves to the *previous* document and the
  // rename lands on that one instead.
  const fresh = page.getByRole("treeitem").filter({ hasText: "Untitled" });
  await expect(fresh).toHaveCount(1);
  await fresh.click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();

  await writeManuscript(page, text);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
}

const openCompile = (page: Page) => page.getByText("Compile and trash").click();

const openSelection = (page: Page) =>
  page.getByText(/Including (the whole manuscript|\d+ of \d+ items)/).click();

const presetPicker = (page: Page) => page.getByLabel("Preset", { exact: true });

async function savePreset(page: Page, name: string) {
  await page.getByLabel("Name this preset").fill(name);
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(presetPicker(page)).toHaveValue(/.+/);
}

test("a saved preset brings back its format and its chapters", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "Chapter One", "She climbed the stair by lamplight.");
  await writeChapter(page, "Chapter Two", "He waited at the foot of it for hours.");

  await openCompile(page);
  await expect(page.getByLabel("Format")).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Format").selectOption("html");
  await openSelection(page);
  await page.getByRole("checkbox", { name: "Chapter One" }).check();
  await savePreset(page, "Agent submission");

  // "The whole manuscript" names a selection, not a format: it clears the one and
  // leaves the other, because an author who chose HTML did not stop wanting HTML.
  await presetPicker(page).selectOption("");
  await expect(page.getByText("Including the whole manuscript")).toBeVisible();
  await page.getByLabel("Format").selectOption("md");

  // And back again. It has to restore both halves, because rebuilding them by hand is
  // the thing a preset exists to stop.
  await presetPicker(page).selectOption({ label: "Agent submission" });
  await expect(page.getByLabel("Format")).toHaveValue("html");
  await expect(page.getByText("Including 1 of 2 items")).toBeVisible();
});

test("THE PRE-FLIGHT COUNTS THE PRESET, NOT THE WHOLE BOOK", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "Chapter One", "She climbed the stair by lamplight.");
  await writeChapter(page, "Chapter Two", "He waited at the foot of it for hours.");

  await openCompile(page);
  // Both chapters: six words and nine.
  await expect(page.getByText(/2 documents, 15 words/i)).toBeVisible({ timeout: 10_000 });

  await openSelection(page);
  await page.getByRole("checkbox", { name: "Chapter One" }).check();

  // Worked out on the device from the same planner the server compiles with, so what
  // it says is what the export will contain.
  await expect(page.getByText(/1 document, 6 words/i)).toBeVisible();
});

test("the export names the preset rather than describing it", async ({ page }) => {
  const posted: string[] = [];
  await stub(page);
  await page.route(`${SERVER}/api/v1/projects/*/compile`, (route) => {
    posted.push(route.request().postData() ?? "");
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-1" }),
    });
  });

  await signIn(page);
  await openProject(page);
  await writeChapter(page, "Chapter One", "She climbed the stair by lamplight.");

  await openCompile(page);
  await expect(page.getByLabel("Format")).toBeVisible({ timeout: 10_000 });
  await openSelection(page);
  await page.getByRole("checkbox", { name: "Chapter One" }).check();
  await savePreset(page, "Agent submission");

  await page.getByRole("button", { name: "Compile" }).click();
  await expect.poll(() => posted.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // The preset id, not an inline config: the compile worker reads the selection off the
  // preset row and compiles only those items. Sending a config instead would export the
  // whole book while the panel said otherwise.
  const body = JSON.parse(posted[0] ?? "{}") as Record<string, unknown>;
  expect(typeof body.presetId).toBe("string");
  expect(body.inlineConfig).toBeUndefined();
});

test("presets can be made with no server at all", async ({ page }) => {
  // No stub and no sign-in: a preset is a local row that syncs later. An author setting
  // up a submission format on a train is doing something the app supports.
  await openProject(page);
  await writeChapter(page, "Chapter One", "She climbed the stair by lamplight.");

  await openCompile(page);
  await openSelection(page);
  await page.getByRole("checkbox", { name: "Chapter One" }).check();
  await savePreset(page, "Agent submission");

  await expect(page.getByText("Including 1 of 1 items")).toBeVisible();
  // The compile itself is the part that needs one, and it says so rather than failing.
  await expect(page.getByText(/Sign in to export this project/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Compile" })).toBeDisabled();

  // Reopened, which is the only proof the preset reached storage rather than React
  // state — and being there next month is most of what a preset is for.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await openCompile(page);
  await presetPicker(page).selectOption({ label: "Agent submission" });
  await expect(page.getByText("Including 1 of 1 items")).toBeVisible();
  await expect(page.getByLabel("Format")).toHaveValue("md");
});

test("deleting a preset puts the whole manuscript back", async ({ page }) => {
  await stub(page);
  await signIn(page);
  await openProject(page);
  await writeChapter(page, "Chapter One", "She climbed the stair by lamplight.");
  await writeChapter(page, "Chapter Two", "He waited at the foot of it for hours.");

  await openCompile(page);
  await expect(page.getByLabel("Format")).toBeVisible({ timeout: 10_000 });
  await openSelection(page);
  await page.getByRole("checkbox", { name: "Chapter One" }).check();
  await savePreset(page, "Agent submission");

  await page.getByRole("button", { name: "Delete Agent submission", exact: true }).click();
  await page.getByRole("button", { name: "Delete Agent submission", exact: true }).click();

  await expect(page.getByText("Including the whole manuscript")).toBeVisible();
  await expect(page.getByText(/2 documents, 15 words/i)).toBeVisible();
});
