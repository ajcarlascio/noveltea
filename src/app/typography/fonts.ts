/**
 * The reading font, chosen by the author.
 *
 * Novelists care about this the way they care about paper, and the choice is
 * theirs — Merriweather is only the default offer. It is bundled rather than
 * fetched: a self-hosted instance may have no internet at all, and the CSP does
 * not allow a font CDN.
 *
 * Same shape as the theme preference deliberately: a validated value in local
 * storage, applied as an attribute on <html>, with the stylesheet holding the
 * actual stacks. See [[theme.ts]].
 */

export const FONT_CHOICES = ["merriweather", "georgia", "system-serif", "system-sans"] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

/** Must match the key used by the pre-paint script in index.html. */
export const FONT_STORAGE_KEY = "noveltea.font";

/** What an author gets before they have an opinion. */
export const DEFAULT_FONT: FontChoice = "merriweather";

export const FONT_LABELS: Record<FontChoice, string> = {
  merriweather: "Merriweather",
  georgia: "Georgia",
  "system-serif": "System serif",
  "system-sans": "System sans",
};

export function isFontChoice(value: unknown): value is FontChoice {
  return typeof value === "string" && (FONT_CHOICES as readonly string[]).includes(value);
}

export function readStoredFont(storage: Pick<Storage, "getItem"> | undefined): FontChoice {
  if (!storage) return DEFAULT_FONT;
  let raw: string | null;
  try {
    raw = storage.getItem(FONT_STORAGE_KEY);
  } catch {
    // Blocked storage is not a reason to fail to render prose.
    return DEFAULT_FONT;
  }
  return isFontChoice(raw) ? raw : DEFAULT_FONT;
}

export function writeStoredFont(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  choice: FontChoice,
): void {
  if (!storage) return;
  try {
    // The default is the absence of a choice, so the pre-paint script and this
    // module cannot disagree about what an unset key means.
    if (choice === DEFAULT_FONT) storage.removeItem(FONT_STORAGE_KEY);
    else storage.setItem(FONT_STORAGE_KEY, choice);
  } catch {
    // Not persisted, but honoured for this session.
  }
}

/** Stamps the choice on <html>; tokens.css maps it to a stack. */
export function applyFont(root: HTMLElement, choice: FontChoice): void {
  if (choice === DEFAULT_FONT) root.removeAttribute("data-font");
  else root.setAttribute("data-font", choice);
}
