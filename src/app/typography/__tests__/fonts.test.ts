import { describe, expect, it } from "vitest";
import {
  applyFont,
  DEFAULT_FONT,
  FONT_CHOICES,
  FONT_LABELS,
  FONT_STORAGE_KEY,
  isFontChoice,
  readStoredFont,
  writeStoredFont,
} from "../fonts";
import { runPrePaintScript } from "@/test/prePaintScript";
import tokens from "@/styles/tokens.css?raw";

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

describe("the catalogue", () => {
  it("offers Merriweather by default", () => {
    // The default is what an author is offered before they have an opinion; the
    // point of the feature is that they can change it.
    expect(DEFAULT_FONT).toBe("merriweather");
  });

  it("labels every choice", () => {
    // A choice with no label renders as a blank radio nobody can identify.
    for (const choice of FONT_CHOICES) {
      expect(FONT_LABELS[choice]).toBeTruthy();
    }
    expect(Object.keys(FONT_LABELS).sort()).toEqual([...FONT_CHOICES].sort());
  });

  it("defines a prose stack for every non-default choice", () => {
    // The default needs no attribute; the rest each need a rule, or picking one
    // silently leaves the previous font in place.
    for (const choice of FONT_CHOICES) {
      if (choice === DEFAULT_FONT) continue;
      expect(tokens).toContain(`:root[data-font="${choice}"]`);
    }
  });

  it("keeps a fallback ahead of the bundled file finishing", () => {
    // The woff2 is ~100KB. Until it lands the text is drawn in whatever comes next
    // in the stack, so there had better be something after Merriweather.
    const stack = /--font-prose: ([^;]+);/.exec(tokens)?.[1] ?? "";
    expect(stack).toMatch(/Merriweather/);
    expect(stack.split(",").length).toBeGreaterThan(2);
  });
});

describe("isFontChoice", () => {
  it("accepts exactly the catalogue", () => {
    expect(FONT_CHOICES.every(isFontChoice)).toBe(true);
  });

  it("rejects near-misses and non-strings", () => {
    for (const bad of ["Merriweather", "serif", "", null, undefined, 1, {}, ["georgia"]]) {
      expect(isFontChoice(bad)).toBe(false);
    }
  });
});

describe("storage", () => {
  it("returns a stored choice", () => {
    expect(readStoredFont(fakeStorage({ [FONT_STORAGE_KEY]: "georgia" }))).toBe("georgia");
  });

  it("falls back for missing, invalid, throwing and absent storage", () => {
    expect(readStoredFont(fakeStorage())).toBe(DEFAULT_FONT);
    expect(readStoredFont(fakeStorage({ [FONT_STORAGE_KEY]: "comic-sans" }))).toBe(DEFAULT_FONT);
    expect(readStoredFont(throwingStorage())).toBe(DEFAULT_FONT);
    expect(readStoredFont(undefined)).toBe(DEFAULT_FONT);
  });

  it("clears the key for the default instead of storing it", () => {
    const storage = fakeStorage({ [FONT_STORAGE_KEY]: "georgia" });
    writeStoredFont(storage, DEFAULT_FONT);
    expect(storage.snapshot()).toEqual({});
  });

  it("does not throw when storage is unavailable", () => {
    expect(() => writeStoredFont(throwingStorage(), "georgia")).not.toThrow();
    expect(() => writeStoredFont(undefined, "georgia")).not.toThrow();
  });
});

describe("applyFont", () => {
  it("stamps a non-default choice", () => {
    const root = document.createElement("html");
    applyFont(root, "georgia");
    expect(root.getAttribute("data-font")).toBe("georgia");
  });

  it("removes the attribute for the default", () => {
    const root = document.createElement("html");
    root.setAttribute("data-font", "georgia");
    applyFont(root, DEFAULT_FONT);
    expect(root.hasAttribute("data-font")).toBe(false);
  });
});

describe("the pre-paint script", () => {
  it("applies a stored font before the app loads", () => {
    // A font applied after first paint reflows the page under the reader, because
    // the metrics differ. It also pins the storage key against drift.
    expect(runPrePaintScript(fakeStorage({ [FONT_STORAGE_KEY]: "georgia" })).font).toBe("georgia");
  });

  it("leaves the attribute off for the default and for nonsense", () => {
    expect(runPrePaintScript(fakeStorage({ [FONT_STORAGE_KEY]: "merriweather" })).font).toBeNull();
    expect(runPrePaintScript(fakeStorage({ [FONT_STORAGE_KEY]: "wingdings" })).font).toBeNull();
    expect(runPrePaintScript(fakeStorage()).font).toBeNull();
  });

  it("knows every non-default choice the app can store", () => {
    // The script and the catalogue agree only by convention. A choice the script
    // does not recognise loads in the wrong font and then snaps to the right one.
    for (const choice of FONT_CHOICES) {
      if (choice === DEFAULT_FONT) continue;
      expect(runPrePaintScript(fakeStorage({ [FONT_STORAGE_KEY]: choice })).font).toBe(choice);
    }
  });

  it("still applies the theme alongside the font", () => {
    const result = runPrePaintScript(
      fakeStorage({ "noveltea.theme": "dark", [FONT_STORAGE_KEY]: "system-sans" }),
    );
    expect(result.theme).toBe("dark");
    expect(result.font).toBe("system-sans");
  });
});
