import { describe, expect, it, vi } from "vitest";
import {
  applyCustomFont,
  clearCustomFont,
  CUSTOM_FONTS_STORAGE_KEY,
  customFontId,
  describeImportError,
  familyFromFileName,
  fontExtension,
  importCustomFont,
  isCustomFontValue,
  loadAndRegisterAllCustomFonts,
  MAX_FONT_BYTES,
  readCustomFonts,
  removeCustomFont,
  validateFontFile,
  writeCustomFonts,
  writeStoredCustomFont,
  type ByteStore,
  type CustomFontAdapters,
} from "../customFonts";
import { DEFAULT_FONT, FONT_STORAGE_KEY } from "../fonts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    snapshot: () => Object.fromEntries(map),
  };
}

function memoryByteStore(kind: "opfs" | "indexeddb" = "opfs"): ByteStore & {
  files: Map<string, ArrayBuffer>;
} {
  const files = new Map<string, ArrayBuffer>();
  return {
    kind,
    files,
    write(id, bytes) {
      files.set(id, bytes);
      return Promise.resolve();
    },
    read(id) {
      return Promise.resolve(files.get(id) ?? null);
    },
    remove(id) {
      files.delete(id);
      return Promise.resolve();
    },
  };
}

function fakeAdapters(overrides: Partial<Omit<CustomFontAdapters, "storage">> = {}): CustomFontAdapters & {
  storage: ReturnType<typeof fakeStorage>;
  addedFaces: unknown[];
} {
  const storage = fakeStorage();
  const addedFaces: unknown[] = [];
  return {
    byteStore: () => Promise.resolve(memoryByteStore()),
    fontFace: { create: () => ({ load: () => Promise.resolve(undefined) }) },
    addFace: (face) => void addedFaces.push(face),
    now: () => 1_700_000_000_000,
    ...overrides,
    // After the spread: storage is not overridable, and its narrower type is what
    // the tests read snapshots through.
    storage,
    addedFaces,
  };
}

const BYTES = new ArrayBuffer(1024);

describe("the custom-font value shape", () => {
  it("recognises custom:<id> and nothing else", () => {
    expect(isCustomFontValue("custom:f1")).toBe(true);
    expect(isCustomFontValue("custom:")).toBe(false);
    expect(isCustomFontValue("georgia")).toBe(false);
    expect(isCustomFontValue("")).toBe(false);
  });

  it("extracts the id", () => {
    expect(customFontId("custom:abc123")).toBe("abc123");
  });
});

describe("validation", () => {
  it("accepts the four font extensions, case-insensitively", () => {
    for (const name of ["a.woff2", "a.woff", "a.otf", "a.TTF"]) {
      expect(validateFontFile(name, 100)).toBeNull();
    }
  });

  it("refuses anything that is not a font file", () => {
    expect(validateFontFile("novel.txt", 100)).toEqual({ kind: "bad-type", fileName: "novel.txt" });
    expect(validateFontFile("font", 100)).toEqual({ kind: "bad-type", fileName: "font" });
    expect(validateFontFile("font.", 100)).toEqual({ kind: "bad-type", fileName: "font." });
  });

  it("refuses an empty file", () => {
    expect(validateFontFile("a.woff2", 0)).toEqual({ kind: "empty", fileName: "a.woff2" });
  });

  it("refuses a file over the cap", () => {
    expect(validateFontFile("a.woff2", MAX_FONT_BYTES + 1)).toEqual({
      kind: "too-large",
      fileName: "a.woff2",
      bytes: MAX_FONT_BYTES + 1,
    });
    // The cap itself is accepted.
    expect(validateFontFile("a.woff2", MAX_FONT_BYTES)).toBeNull();
  });

  it("names the extension it found", () => {
    expect(fontExtension("My-Font.WOFF2")).toBe("woff2");
    expect(fontExtension("no-extension")).toBeNull();
  });

  it("derives a presentable family from the file name", () => {
    expect(familyFromFileName("Crimson-Pro-Bold.woff2")).toBe("Crimson Pro Bold");
    expect(familyFromFileName("plain")).toBe("plain");
  });

  it("strips what a CSS parser would choke on out of a family name", () => {
    // The name reaches new FontFace(), which throws on an invalid font-family, and
    // the --font-prose value, where CSSOM silently drops an invalid value and the
    // font just never applies. A file name is author-controlled, so neither can be
    // assumed well-formed.
    expect(familyFromFileName('Bad"Quote.ttf')).toBe("BadQuote");
    expect(familyFromFileName("Back\\slash.otf")).toBe("Backslash");
    expect(familyFromFileName("Line\nBreak.woff")).toBe("Line Break");
    // A name made entirely of those characters still has to be something.
    expect(familyFromFileName('"""".woff2')).toBe("Imported font");
  });

  it("keeps a sanitised family usable in the CSS it is written into", () => {
    const root = document.createElement("html");
    applyCustomFont(root, familyFromFileName('Bad"Quote.ttf'));
    // If the quote had survived, setProperty would have rejected the whole value
    // and this would be the empty string.
    expect(root.style.getPropertyValue("--font-prose")).toContain('"BadQuote"');
  });

  it("describes every error in a sentence an author can act on", () => {
    expect(describeImportError({ kind: "bad-type", fileName: "x.txt" })).toMatch(/not a font/);
    expect(describeImportError({ kind: "empty", fileName: "x.otf" })).toMatch(/empty/);
    expect(
      describeImportError({ kind: "too-large", fileName: "x.otf", bytes: MAX_FONT_BYTES + 1 }),
    ).toMatch(/10 MB/);
    expect(describeImportError({ kind: "no-store" })).toMatch(/nowhere to keep/);
    expect(describeImportError({ kind: "unreadable", fileName: "x.otf" })).toMatch(/could not be read/);
  });
});

describe("metadata storage", () => {
  it("round-trips the list", () => {
    const storage = fakeStorage();
    const meta = { id: "f1", family: "Crimson Pro", fileName: "crimson.woff2", addedAt: 1 };
    writeCustomFonts(storage, [meta]);
    expect(readCustomFonts(storage)).toEqual([meta]);
  });

  it("removes the key when the list empties", () => {
    const storage = fakeStorage({ [CUSTOM_FONTS_STORAGE_KEY]: "[]" });
    writeCustomFonts(storage, []);
    expect(storage.snapshot()).toEqual({});
  });

  it("survives corrupted, non-array and throwing storage", () => {
    expect(readCustomFonts(fakeStorage({ [CUSTOM_FONTS_STORAGE_KEY]: "{oops" }))).toEqual([]);
    expect(readCustomFonts(fakeStorage({ [CUSTOM_FONTS_STORAGE_KEY]: '"a string"' }))).toEqual([]);
    const boom = () => {
      throw new DOMException("insecure", "SecurityError");
    };
    expect(readCustomFonts({ getItem: boom })).toEqual([]);
    expect(readCustomFonts(undefined)).toEqual([]);
  });

  it("drops entries that are not metadata", () => {
    const storage = fakeStorage({
      [CUSTOM_FONTS_STORAGE_KEY]: JSON.stringify([
        { id: "f1", family: "Good", fileName: "good.woff2", addedAt: 1 },
        { id: 42 },
        null,
        "junk",
      ]),
    });
    expect(readCustomFonts(storage)).toHaveLength(1);
  });
});

describe("importCustomFont", () => {
  it("stores the bytes, records the metadata and registers the face", async () => {
    const store = memoryByteStore();
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(store) });
    const result = await importCustomFont(adapters, "Crimson-Pro.woff2", BYTES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.family).toBe("Crimson Pro");
    expect(store.files.get(result.meta.id)).toBe(BYTES);
    expect(readCustomFonts(adapters.storage)).toEqual([result.meta]);
    expect(adapters.addedFaces).toHaveLength(1);
  });

  it("refuses a non-font without touching the store", async () => {
    const store = memoryByteStore();
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(store) });
    const result = await importCustomFont(adapters, "manuscript.txt", BYTES);
    expect(result).toEqual({ ok: false, error: { kind: "bad-type", fileName: "manuscript.txt" } });
    expect(store.files.size).toBe(0);
    expect(readCustomFonts(adapters.storage)).toEqual([]);
  });

  it("refuses when the platform has nowhere to keep the bytes", async () => {
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(null) });
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    expect(result).toEqual({ ok: false, error: { kind: "no-store" } });
    expect(readCustomFonts(adapters.storage)).toEqual([]);
  });

  it("reports a write failure as unreadable and records nothing", async () => {
    const adapters = fakeAdapters({
      byteStore: () =>
        Promise.resolve({
          kind: "opfs" as const,
          // Rejected rather than thrown from an async body: identical to the caller,
          // and honest to a linter that asks why an async function never awaits.
          write: () => Promise.reject(new Error("quota")),
          read: () => Promise.resolve(null),
          remove: () => Promise.resolve(),
        }),
    });
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    expect(result).toEqual({ ok: false, error: { kind: "unreadable", fileName: "a.woff2" } });
    expect(readCustomFonts(adapters.storage)).toEqual([]);
  });

  it("keeps the metadata when the face will not load, so the next launch can retry", async () => {
    const adapters = fakeAdapters({
      fontFace: {
        create: () => ({
          load: () => Promise.reject(new Error("bad glyphs")),
        }),
      },
    });
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    expect(result.ok).toBe(true);
    expect(readCustomFonts(adapters.storage)).toHaveLength(1);
    expect(adapters.addedFaces).toHaveLength(0);
  });
});

describe("writeStoredCustomFont", () => {
  it("writes the custom:<id> value under the shared font key", () => {
    const storage = fakeStorage();
    writeStoredCustomFont(storage, "f1");
    expect(storage.getItem(FONT_STORAGE_KEY)).toBe("custom:f1");
  });

  it("does not throw without storage", () => {
    expect(() => writeStoredCustomFont(undefined, "f1")).not.toThrow();
  });
});

describe("removeCustomFont", () => {
  it("removes metadata and bytes", async () => {
    const store = memoryByteStore();
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(store) });
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    if (!result.ok) throw new Error("import failed");
    await removeCustomFont(adapters, result.meta.id);
    expect(readCustomFonts(adapters.storage)).toEqual([]);
    expect(store.files.size).toBe(0);
  });

  it("reverts the selection to the default when the removed font was chosen", async () => {
    const adapters = fakeAdapters();
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    if (!result.ok) throw new Error("import failed");
    writeStoredCustomFont(adapters.storage, result.meta.id);
    await removeCustomFont(adapters, result.meta.id);
    // The default is the absence of a choice.
    expect(adapters.storage.getItem(FONT_STORAGE_KEY)).toBeNull();
  });

  it("leaves a different selection alone", async () => {
    const adapters = fakeAdapters();
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    if (!result.ok) throw new Error("import failed");
    adapters.storage.setItem(FONT_STORAGE_KEY, "georgia");
    await removeCustomFont(adapters, result.meta.id);
    expect(adapters.storage.getItem(FONT_STORAGE_KEY)).toBe("georgia");
  });

  it("is a no-op for an unknown id", async () => {
    const adapters = fakeAdapters();
    await importCustomFont(adapters, "a.woff2", BYTES);
    await removeCustomFont(adapters, "nope");
    expect(readCustomFonts(adapters.storage)).toHaveLength(1);
  });
});

describe("loadAndRegisterAllCustomFonts", () => {
  it("registers every stored face and applies the selected one", async () => {
    const store = memoryByteStore();
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(store) });
    const first = await importCustomFont(adapters, "first.woff2", BYTES);
    const second = await importCustomFont(adapters, "second.woff2", BYTES);
    if (!first.ok || !second.ok) throw new Error("import failed");
    writeStoredCustomFont(adapters.storage, second.meta.id);
    adapters.addedFaces.length = 0;

    const root = document.createElement("html");
    await loadAndRegisterAllCustomFonts(adapters, root);

    expect(adapters.addedFaces).toHaveLength(2);
    expect(root.getAttribute("data-font")).toBe("custom");
    expect(root.style.getPropertyValue("--font-prose")).toContain('"second"');
  });

  it("registers without applying when the selection is a bundled face", async () => {
    const store = memoryByteStore();
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(store) });
    await importCustomFont(adapters, "a.woff2", BYTES);
    adapters.storage.setItem(FONT_STORAGE_KEY, "georgia");
    adapters.addedFaces.length = 0;

    const root = document.createElement("html");
    await loadAndRegisterAllCustomFonts(adapters, root);

    expect(adapters.addedFaces).toHaveLength(1);
    expect(root.hasAttribute("data-font")).toBe(false);
    expect(root.style.getPropertyValue("--font-prose")).toBe("");
  });

  it("skips a font whose bytes have gone missing", async () => {
    const store = memoryByteStore();
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(store) });
    const result = await importCustomFont(adapters, "a.woff2", BYTES);
    if (!result.ok) throw new Error("import failed");
    store.files.clear();
    adapters.addedFaces.length = 0;

    await loadAndRegisterAllCustomFonts(adapters, document.createElement("html"));
    expect(adapters.addedFaces).toHaveLength(0);
  });

  it("does nothing when there are no custom fonts", async () => {
    const adapters = fakeAdapters();
    const byteStore = vi.fn(() => Promise.resolve(memoryByteStore()));
    await loadAndRegisterAllCustomFonts({ ...adapters, byteStore }, document.createElement("html"));
    // No fonts means no reason to even open the store.
    expect(byteStore).not.toHaveBeenCalled();
  });

  it("does nothing when the platform has no store", async () => {
    const adapters = fakeAdapters({ byteStore: () => Promise.resolve(null) });
    await importCustomFont(
      { ...adapters, byteStore: () => Promise.resolve(memoryByteStore()) },
      "a.woff2",
      BYTES,
    );
    adapters.addedFaces.length = 0;
    await loadAndRegisterAllCustomFonts(adapters, document.createElement("html"));
    expect(adapters.addedFaces).toHaveLength(0);
  });
});

describe("applyCustomFont / clearCustomFont", () => {
  it("stamps the custom marker and an inline prose stack with fallbacks", () => {
    const root = document.createElement("html");
    applyCustomFont(root, "Crimson Pro");
    expect(root.getAttribute("data-font")).toBe("custom");
    const stack = root.style.getPropertyValue("--font-prose");
    expect(stack).toContain('"Crimson Pro"');
    expect(stack.split(",").length).toBeGreaterThan(1);
  });

  it("clearing removes the inline property so stylesheet rules win again", () => {
    const root = document.createElement("html");
    applyCustomFont(root, "Crimson Pro");
    clearCustomFont(root);
    expect(root.style.getPropertyValue("--font-prose")).toBe("");
  });
});

describe("the default font guard", () => {
  it("still rejects custom values, which the chooser handles separately", () => {
    // The catalogue and the custom list must not blur: readStoredFont falls back
    // for a custom:<id> value, and the chooser reads the raw key first.
    expect(DEFAULT_FONT).toBe("merriweather");
  });
});
