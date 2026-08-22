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

export const FONT_CHOICES = [
  "merriweather",
  "eb-garamond",
  "lora",
  "atkinson",
  "georgia",
  "system-serif",
  "system-sans",
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

/** Must match the key used by the pre-paint script in index.html. */
export const FONT_STORAGE_KEY = "noveltea.font";

/** What an author gets before they have an opinion. */
export const DEFAULT_FONT: FontChoice = "merriweather";

export const FONT_LABELS: Record<FontChoice, string> = {
  merriweather: "Merriweather",
  "eb-garamond": "EB Garamond",
  lora: "Lora",
  atkinson: "Atkinson Hyperlegible",
  georgia: "Georgia",
  "system-serif": "System serif",
  "system-sans": "System sans",
};

/** Said in the chooser, because "which serif" is not a useful question on its own. */
export const FONT_NOTES: Record<FontChoice, string> = {
  merriweather: "Made for screens. Sturdy at small sizes.",
  "eb-garamond": "A book face, close to what a printed novel uses.",
  lora: "Contemporary, with some brushed contrast.",
  atkinson: "Drawn for low vision: letters that are hard to confuse.",
  georgia: "On most machines already. Wide and even.",
  "system-serif": "Whatever this device calls a serif.",
  "system-sans": "Whatever this device calls a sans.",
};

/**
 * How large the manuscript is set.
 *
 * A scale rather than a point size: the editor's measure, line height and margins are
 * all in ems, so one multiplier moves the whole page together instead of leaving the
 * text large inside a column sized for something smaller.
 */
export const FONT_SIZES = ["small", "medium", "large", "x-large"] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export const FONT_SIZE_STORAGE_KEY = "noveltea.fontSize";
export const DEFAULT_FONT_SIZE: FontSize = "medium";

export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  "x-large": "Extra large",
};

export function isFontSize(value: unknown): value is FontSize {
  return typeof value === "string" && (FONT_SIZES as readonly string[]).includes(value);
}

export function readStoredFontSize(storage: Pick<Storage, "getItem"> | undefined): FontSize {
  if (!storage) return DEFAULT_FONT_SIZE;
  try {
    const raw = storage.getItem(FONT_SIZE_STORAGE_KEY);
    return isFontSize(raw) ? raw : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function writeStoredFontSize(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  size: FontSize,
): void {
  if (!storage) return;
  try {
    if (size === DEFAULT_FONT_SIZE) storage.removeItem(FONT_SIZE_STORAGE_KEY);
    else storage.setItem(FONT_SIZE_STORAGE_KEY, size);
  } catch {
    // Not persisted, but honoured for this session.
  }
}

/** Stamps the size on <html>; tokens.css maps it to a multiplier. */
export function applyFontSize(root: HTMLElement, size: FontSize): void {
  if (size === DEFAULT_FONT_SIZE) root.removeAttribute("data-font-size");
  else root.setAttribute("data-font-size", size);
}

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
