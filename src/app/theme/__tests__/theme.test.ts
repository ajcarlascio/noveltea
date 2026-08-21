import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  DEFAULT_THEME,
  isThemeChoice,
  readStoredTheme,
  THEME_STORAGE_KEY,
  writeStoredTheme,
} from "../theme";
import { runPrePaintScript } from "@/test/prePaintScript";
import indexHtml from "../../../../index.html?raw";

/** A storage double whose behaviour each test can choose. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    snapshot: () => Object.fromEntries(map),
  };
}

function throwingStorage() {
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

describe("isThemeChoice", () => {
  it("accepts exactly the three choices", () => {
    expect(["light", "dark", "system"].every(isThemeChoice)).toBe(true);
  });

  it("rejects near-misses and non-strings", () => {
    for (const bad of ["Light", "DARK", "auto", "", " light", null, undefined, 1, {}, ["light"]]) {
      expect(isThemeChoice(bad)).toBe(false);
    }
  });
});

describe("readStoredTheme", () => {
  it("returns a stored choice", () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readStoredTheme(fakeStorage())).toBe(DEFAULT_THEME);
  });

  it("falls back when the stored value is not a valid choice", () => {
    // A value left by an older build, or edited by hand in devtools.
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe(DEFAULT_THEME);
  });

  it("falls back when storage itself throws", () => {
    // Safari private browsing and locked-down embedded webviews both do this.
    expect(readStoredTheme(throwingStorage())).toBe(DEFAULT_THEME);
  });

  it("falls back when there is no storage at all", () => {
    expect(readStoredTheme(undefined)).toBe(DEFAULT_THEME);
  });
});

describe("writeStoredTheme", () => {
  it("persists an explicit choice", () => {
    const storage = fakeStorage();
    writeStoredTheme(storage, "dark");
    expect(storage.snapshot()).toEqual({ [THEME_STORAGE_KEY]: "dark" });
  });

  it("clears the key for 'system' instead of storing it", () => {
    // The pre-paint script treats "no key" as "follow the OS". Writing the literal
    // string "system" would leave that script reading a value it does not handle.
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
    writeStoredTheme(storage, "system");
    expect(storage.snapshot()).toEqual({});
  });

  it("does not throw when storage is unavailable", () => {
    expect(() => writeStoredTheme(throwingStorage(), "dark")).not.toThrow();
    expect(() => writeStoredTheme(undefined, "dark")).not.toThrow();
  });
});

describe("applyTheme", () => {
  it("stamps data-theme for an explicit choice", () => {
    const root = document.createElement("html");
    applyTheme(root, "dark", "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("removes data-theme for 'system' so the media query decides", () => {
    const root = document.createElement("html");
    root.setAttribute("data-theme", "dark");
    applyTheme(root, "system", "light");
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("sets color-scheme from the resolved theme, not the choice", () => {
    // On "system" there is no attribute to read, so native controls would default
    // to light against a dark page unless color-scheme is set explicitly.
    const root = document.createElement("html");
    applyTheme(root, "system", "dark");
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
  });
});

describe("pre-paint script in index.html", () => {
  // Executed, not string-matched. The script exists to run before any module can,
  // so it cannot be imported — but asserting on its source would break on any
  // rewrite while proving nothing about its behaviour.

  it("applies a stored explicit choice before the app loads", () => {
    // This is also what pins the storage key: the script and THEME_STORAGE_KEY
    // agree only by convention, and a mismatch means a dark-mode reader gets a
    // white flash on every load with nothing failing anywhere.
    const { theme } = runPrePaintScript(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }));
    expect(theme).toBe("dark");
  });

  it("leaves the attribute off for 'system' so the media query decides", () => {
    expect(runPrePaintScript(fakeStorage({ [THEME_STORAGE_KEY]: "system" })).theme).toBeNull();
  });

  it("leaves the attribute off when nothing is stored", () => {
    expect(runPrePaintScript(fakeStorage()).theme).toBeNull();
  });

  it("ignores a value that is not a theme", () => {
    expect(runPrePaintScript(fakeStorage({ [THEME_STORAGE_KEY]: "sepia" })).theme).toBeNull();
    expect(runPrePaintScript(fakeStorage({ [THEME_STORAGE_KEY]: "Dark" })).theme).toBeNull();
  });

  it("does not throw when storage is blocked", () => {
    // Without the catch, a browser that refuses localStorage gets a blank page:
    // this script runs in <head>, before anything has rendered.
    const result = runPrePaintScript(throwingStorage());
    expect(result.threw).toBeNull();
    expect(result.theme).toBeNull();
  });

  it("runs before the app bundle so there is no flash of the wrong theme", () => {
    expect(indexHtml.indexOf("localStorage")).toBeLessThan(indexHtml.indexOf("/src/main.tsx"));
  });
});

describe("storage double", () => {
  it("is not silently a no-op", () => {
    // Guards the tests above: if the double stopped recording, the write tests
    // would pass against a broken writeStoredTheme.
    const storage = fakeStorage();
    storage.setItem("k", "v");
    expect(storage.snapshot()).toEqual({ k: "v" });
    expect(vi.isMockFunction(storage.getItem)).toBe(false);
  });
});
