/**
 * Theme model, kept free of React so it can be unit-tested and reused by the
 * pre-paint script's contract tests.
 */

export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** What the reader actually sees. "system" always resolves to one of these. */
export type ResolvedTheme = "light" | "dark";

/** Must match the key used by the pre-paint script in index.html. */
export const THEME_STORAGE_KEY = "noveltea.theme";

export const DEFAULT_THEME: ThemeChoice = "system";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/**
 * Storage is not guaranteed to exist or to be readable: Safari private mode throws
 * on access, embedded webviews can disable it, and the stored value may be stale
 * from an older build or edited by hand. Any of those means "no preference", never
 * a crash on boot.
 */
export function readStoredTheme(storage: Pick<Storage, "getItem"> | undefined): ThemeChoice {
  if (!storage) return DEFAULT_THEME;
  let raw: string | null;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    return DEFAULT_THEME;
  }
  return isThemeChoice(raw) ? raw : DEFAULT_THEME;
}

export function writeStoredTheme(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  choice: ThemeChoice,
): void {
  if (!storage) return;
  try {
    // "system" is the absence of a choice. Storing it would make the pre-paint
    // script and the provider disagree about what an unset key means.
    if (choice === DEFAULT_THEME) storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A reader whose storage is full or blocked still gets the theme for this
    // session; it just will not survive a reload.
  }
}

/**
 * Writes the choice onto <html>. An explicit choice stamps `data-theme`; "system"
 * removes the attribute so the `prefers-color-scheme` rules in tokens.css apply.
 * `color-scheme` is set from the *resolved* theme so native scrollbars, form
 * controls and the canvas behind the page follow along.
 */
export function applyTheme(root: HTMLElement, choice: ThemeChoice, resolved: ResolvedTheme): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  root.style.setProperty("color-scheme", resolved);
}
