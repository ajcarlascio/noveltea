import { expect, type Page } from "@playwright/test";

/**
 * Replaces the whole manuscript with `text`.
 *
 * `fill`, not select-all-then-type. ProseMirror's Mod-A binding needs the editor to
 * already hold focus and does not have it after typing in a side panel, and
 * triple-click selects the paragraph on Chromium but not dependably on WebKit.
 * `fill` clears the contenteditable itself, whatever the engine.
 *
 * Clicked near the top rather than at the element's centre: the surface is taller
 * than its scroller, so its midpoint can sit behind a panel and the click lands
 * there.
 *
 * Retried as a whole, because `fill` on a contenteditable is two steps that are not
 * atomic against the page: the injected script selects the node's contents, then the
 * text arrives over the wire. Anything that touches the DOM in between — a React
 * re-render after an autosave announces itself — collapses that selection back to
 * the caret, and the new prose is *prepended* to the old rather than replacing it.
 * On a loaded CI runner that window is wide enough to hit, and it fails as
 * "…in the dark.She climbed the stair by lamplight." Retrying is the fix because the
 * second attempt starts from a settled page.
 */
export async function writeManuscript(page: Page, text: string): Promise<void> {
  const surface = page.getByRole("textbox", { name: "Manuscript" });
  await expect(async () => {
    await surface.click({ position: { x: 12, y: 12 } });
    await surface.fill(text);
    await expect(surface).toHaveText(text, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
