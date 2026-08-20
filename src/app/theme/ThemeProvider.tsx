import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext, type ThemeContextValue } from "./ThemeContext";
import {
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
  type ResolvedTheme,
  type ThemeChoice,
} from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * `matchMedia` is missing in some embedded webviews and in bare jsdom, and older
 * WebKit exposes only the deprecated `addListener`. Neither is a reason to fail to
 * render the app, so both degrade to "light".
 */
function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  let query: MediaQueryList;
  try {
    query = window.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  if (typeof query.addListener === "function") {
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }
  return () => {};
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    // Accessing the property itself throws when storage is blocked by policy.
    return undefined;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() =>
    readStoredTheme(safeLocalStorage()),
  );
  const [systemIsDark, setSystemIsDark] = useState<boolean>(prefersDark);

  // Track the OS preference whether or not it is currently in use, so switching
  // back to "system" lands on the right theme immediately rather than after the
  // next OS change.
  useEffect(() => subscribeToSystemTheme(() => setSystemIsDark(prefersDark())), []);

  const resolved: ResolvedTheme =
    choice === "system" ? (systemIsDark ? "dark" : "light") : choice;

  useEffect(() => {
    applyTheme(document.documentElement, choice, resolved);
  }, [choice, resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    writeStoredTheme(safeLocalStorage(), next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ choice, resolved, setChoice }),
    [choice, resolved, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
