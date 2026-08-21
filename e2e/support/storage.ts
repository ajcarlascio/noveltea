import type { Page } from "@playwright/test";

/**
 * Whether this engine can persist at all.
 *
 * Chromium has OPFS; the WebKit build Playwright ships has no `navigator.storage`
 * whatsoever, so the app falls back to an in-memory database. That fallback is a
 * supported state with its own required behaviour — it is not a reason to skip the
 * engine, so the specs branch on this rather than assuming persistence everywhere.
 *
 * This says nothing about *Safari*, which has had OPFS since 17. It is a property of
 * the build under test. See README, "Storage across engines".
 */
export function hasOpfs(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof navigator.storage !== "undefined" &&
      typeof navigator.storage.getDirectory === "function",
  );
}
