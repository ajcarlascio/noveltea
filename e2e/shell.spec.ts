import { expect, test, type Page } from "@playwright/test";

/**
 * The shell under a real engine: the security policy it ships with, and the
 * layout under a finger rather than a mouse. None of this is visible to jsdom,
 * which has no CSP, no layout engine and no notion of a coarse pointer.
 */

/** Console errors and blocked-resource reports, collected for the whole page life. */
function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

test.describe("content security policy", () => {
  test("ships a policy that still lets the database run", async ({ page }) => {
    const problems = collectProblems(page);

    await page.goto("/projects");
    await expect(page.locator("html")).toHaveAttribute("data-db-status", "ready", {
      timeout: 30_000,
    });

    // A CSP that blocks wasm or the worker fails here rather than in front of an
    // author, and the failure text names the directive that did it.
    expect(problems.filter((p) => /content security policy|refused to/i.test(p))).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("declares the directives the app actually depends on", async ({ page }) => {
    await page.goto("/projects");
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");

    expect(policy).toBeTruthy();
    // wasm-unsafe-eval: sqlite-wasm compiles WebAssembly. Removing it is the most
    // likely well-meaning "tightening" and it takes the whole database with it.
    expect(policy).toContain("wasm-unsafe-eval");
    // The inline theme script runs by hash, never by 'unsafe-inline'.
    const scriptSrc = /script-src ([^;]+)/.exec(policy ?? "")?.[1] ?? "";
    expect(scriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(policy).toContain("worker-src");
    expect(policy).toContain("object-src 'none'");

    // Deliberately absent: a <meta> policy cannot express frame-ancestors, and the
    // browser logs a warning and ignores it. Listing it would look like clickjacking
    // protection while providing none — that belongs in a response header.
    expect(policy).not.toContain("frame-ancestors");
  });
});

test.describe("keyboard", () => {
  test("offers a skip link that reaches the content", async ({ page }) => {
    await page.goto("/projects");
    await page.keyboard.press("Tab");

    const skip = page.getByRole("link", { name: /skip to content/i });
    await expect(skip).toBeFocused();
    // Hidden until focused, then genuinely on screen — not merely in the DOM.
    await expect(skip).toBeInViewport();

    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
  });
});
