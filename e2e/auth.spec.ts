import { expect, test, type Page } from "@playwright/test";
import { hasOpfs } from "./support/storage";

/**
 * Signing in, against a stubbed server. There is no NovelTea instance in CI, and the
 * point of these tests is the client's behaviour: which address it posts to, what it
 * says when that address cannot be reached, and that none of it is required in order
 * to write.
 */

const SERVER = "https://write.example.test";

async function stubServer(page: Page, handler: (route: import("@playwright/test").Route) => unknown) {
  await page.route(`${SERVER}/api/v1/auth/**`, handler);
}

const sessionBody = JSON.stringify({
  userId: "11111111-1111-1111-1111-111111111111",
  deviceId: "22222222-2222-2222-2222-222222222222",
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
});

test("writing needs no account", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });

  // The replica is local and complete. Requiring a server before an author can type
  // would contradict the rule this client is built on.
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("link", { name: "Untitled project" }).first().click();
  await expect(page.getByRole("heading", { name: "Binder" })).toBeVisible();

  await expect(page.getByRole("link", { name: /sign in to sync/i })).toBeVisible();
});

test("asks for a server, and refuses one that is not a web address", async ({ page }) => {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Server address").fill("javascript:alert(1)");
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toContainText(/https:\/\/ or http:\/\//);
});

test("warns before sending a password over plain HTTP", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Server address").fill("http://write.example.test");
  await expect(page.getByRole("alert")).toContainText(/not encrypted/i);
});

test("explains an unreachable server rather than blaming the password", async ({ page }) => {
  await page.route(`${SERVER}/**`, (route) => route.abort("connectionrefused"));

  await page.goto("/signin");
  await page.getByLabel("Server address").fill(SERVER);
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  const alert = page.getByRole("alert");
  // The CORS case is the one a self-hoster actually hits and the one that looks
  // least like what it is, so the message names it.
  await expect(alert).toContainText(/could not reach/i);
  await expect(alert).toContainText("cors.allowed-origins");
  await expect(alert).not.toContainText(/do not match an account/i);
});

test("says the same thing for a wrong password as for an unknown address", async ({ page }) => {
  const messages: string[] = [];

  for (const body of [
    { code: "invalid_credentials", message: "no such account" },
    { code: "invalid_credentials", message: "wrong password" },
  ]) {
    await stubServer(page, (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(body) }),
    );
    await page.goto("/signin");
    await page.getByLabel("Server address").fill(SERVER);
    await page.getByLabel("Email").fill("author@example.com");
    await page.getByLabel("Password").fill("whatever");
    await page.getByRole("button", { name: "Sign in" }).click();
    messages.push((await page.getByRole("alert").innerText()).trim());
  }

  // Login must not become a way to find out which addresses have accounts.
  expect(new Set(messages).size).toBe(1);
});

test("signs in, remembers the server, and offers it next time", async ({ page }) => {
  await stubServer(page, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );

  await page.goto("/signin");
  await page.getByLabel("Server address").fill(SERVER);
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("author@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/signin");

  // Remembered, so the common case of two or three servers is not retyped.
  await expect(page.getByLabel("Server")).toBeVisible();
  await expect(page.getByRole("option", { name: SERVER })).toBeAttached();
  await expect(page.getByLabel("Email")).toHaveValue("author@example.com");
});

test("signing out leaves the local work alone", async ({ page }) => {
  await page.goto("/projects");
  test.skip(
    !(await hasOpfs(page)),
    "Without OPFS nothing survives a navigation, so this proves nothing about sign-out.",
  );

  await stubServer(page, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }),
  );

  await page.goto("/projects");
  await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByRole("link", { name: "Untitled project" })).toBeVisible();

  await page.goto("/signin");
  await page.getByLabel("Server address").fill(SERVER);
  await page.getByLabel("Email").fill("author@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/projects");

  // A routine action must not destroy a novel that has not synced yet.
  await expect(page.getByRole("link", { name: "Untitled project" })).toBeVisible();
});
