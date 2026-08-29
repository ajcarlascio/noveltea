/**
 * Fonts an author imports themselves, kept on this device only.
 *
 * The bundled faces are shipped with the app; these are the author's own files,
 * so they never sync and never touch the server. The bytes live in OPFS when the
 * platform has it and in IndexedDB when it does not — WebKitGTK, which the Linux
 * desktop shell runs, has no `navigator.storage` at all (see docs/contributing.md), and a
 * font store that only works where OPFS exists would take the feature away from
 * exactly the shell that needs it most.
 *
 * Registration goes through the FontFace API with the raw bytes. That is not a
 * fetch — the CSP's `font-src 'self'` never sees it — which is why this module
 * never builds a blob: or data: URL for a font.
 *
 * Everything the platform provides arrives through the adapters below, so the
 * logic is testable in jsdom, which has none of it.
 */

import { DEFAULT_FONT, FONT_STORAGE_KEY, writeStoredFont } from "./fonts";

/** The storage key's value takes this shape when it names an imported font. */
export const CUSTOM_FONT_PREFIX = "custom:";

/**
 * A stored selection that names an imported font.
 *
 * Its own type rather than `string`, so a selection can be `FontChoice | CustomFontValue`
 * without `string` swallowing the half that is a closed set — and so narrowing one way
 * genuinely narrows the other.
 */
export type CustomFontValue = `${typeof CUSTOM_FONT_PREFIX}${string}`;

export function isCustomFontValue(value: string): value is CustomFontValue {
  return value.startsWith(CUSTOM_FONT_PREFIX) && value.length > CUSTOM_FONT_PREFIX.length;
}

export function customFontId(value: string): string {
  return value.slice(CUSTOM_FONT_PREFIX.length);
}

export interface CustomFontMeta {
  id: string;
  /** Derived from the file name; what the chooser shows. */
  family: string;
  fileName: string;
  addedAt: number;
}

export const CUSTOM_FONTS_STORAGE_KEY = "noveltea.fonts.custom";

/** The extensions an author is likely to mean; anything else is refused. */
const FONT_EXTENSIONS = ["woff2", "woff", "otf", "ttf"] as const;

/** A face this size is either a mistake or a font with everything in it. */
export const MAX_FONT_BYTES = 10 * 1024 * 1024;

export type FontImportError =
  | { kind: "bad-type"; fileName: string }
  | { kind: "too-large"; fileName: string; bytes: number }
  | { kind: "empty"; fileName: string }
  | { kind: "no-store" }
  | { kind: "unreadable"; fileName: string };

export interface FontImport {
  meta: CustomFontMeta;
  bytes: ArrayBuffer;
}

/** Where the bytes can live. OPFS is preferred; IndexedDB is the fallback. */
export type ByteStoreKind = "opfs" | "indexeddb";

export interface ByteStore {
  kind: ByteStoreKind;
  write(id: string, bytes: ArrayBuffer): Promise<void>;
  read(id: string): Promise<ArrayBuffer | null>;
  remove(id: string): Promise<void>;
}

/** The FontFace constructor, injected because jsdom does not have one. */
export interface FontFaceFactory {
  create(family: string, bytes: ArrayBuffer): { load(): Promise<unknown> };
}

export interface CustomFontAdapters {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  /** Resolves to the store this platform can actually persist with, or null. */
  byteStore(): Promise<ByteStore | null>;
  fontFace: FontFaceFactory;
  /** Called once a face is usable, so the document can start drawing it. */
  addFace(face: unknown): void;
  now(): number;
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

export function readCustomFonts(
  storage: Pick<Storage, "getItem"> | undefined,
): CustomFontMeta[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(CUSTOM_FONTS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CustomFontMeta =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as CustomFontMeta).id === "string" &&
        typeof (entry as CustomFontMeta).family === "string" &&
        typeof (entry as CustomFontMeta).fileName === "string",
    );
  } catch {
    // A corrupted list is not a reason to crash the chooser; it is a reason to
    // start again from an empty one.
    return [];
  }
}

export function writeCustomFonts(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  fonts: CustomFontMeta[],
): void {
  if (!storage) return;
  try {
    if (fonts.length === 0) storage.removeItem(CUSTOM_FONTS_STORAGE_KEY);
    else storage.setItem(CUSTOM_FONTS_STORAGE_KEY, JSON.stringify(fonts));
  } catch {
    // Not persisted, but honoured for this session.
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export function fontExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return (FONT_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/**
 * The file name without its extension, tidied into a presentable family name.
 *
 * The result reaches two CSS parsers — `new FontFace(family, …)`, which rejects a
 * name that is not a valid font-family, and the `--font-prose` value written by
 * applyCustomFont. A file called `a".ttf` would break both: FontFace throws, and
 * CSSOM silently drops an invalid value, so the font just would not apply and
 * nothing would say why. Quotes, backslashes and control characters are dropped
 * here rather than escaped, because a family name is a label an author reads, and
 * a font called `a\22 ` helps nobody.
 */
export function familyFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const spaced = stem
    // Quotes and backslashes are removed: they are not word boundaries, and a
    // family called `Bad Quote` reads worse than `BadQuote` for a file called
    // `Bad"Quote`. Control characters become spaces, because they sit where a
    // separator was meant to be.
    .replace(/["'\\]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.length > 0 ? spaced : "Imported font";
}

export function validateFontFile(
  fileName: string,
  byteLength: number,
): FontImportError | null {
  if (fontExtension(fileName) === null) return { kind: "bad-type", fileName };
  if (byteLength === 0) return { kind: "empty", fileName };
  if (byteLength > MAX_FONT_BYTES) return { kind: "too-large", fileName, bytes: byteLength };
  return null;
}

export function describeImportError(error: FontImportError): string {
  switch (error.kind) {
    case "bad-type":
      return `“${error.fileName}” is not a font file. Import .woff2, .woff, .otf or .ttf.`;
    case "empty":
      return `“${error.fileName}” is empty.`;
    case "too-large":
      return `“${error.fileName}” is larger than 10 MB.`;
    case "no-store":
      return "This device offers nowhere to keep a font file, so it cannot be imported.";
    case "unreadable":
      return `“${error.fileName}” could not be read.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Import and removal                                                          */
/* -------------------------------------------------------------------------- */

export interface ImportResult {
  ok: true;
  meta: CustomFontMeta;
}

/**
 * Validates, stores and registers one font file.
 *
 * Returns the metadata on success and a typed error otherwise; nothing here
 * throws, because every failure is an author-facing message, not a defect.
 */
export async function importCustomFont(
  adapters: CustomFontAdapters,
  fileName: string,
  bytes: ArrayBuffer,
): Promise<ImportResult | { ok: false; error: FontImportError }> {
  const invalid = validateFontFile(fileName, bytes.byteLength);
  if (invalid !== null) return { ok: false, error: invalid };

  const store = await adapters.byteStore();
  if (store === null) return { ok: false, error: { kind: "no-store" } };

  const meta: CustomFontMeta = {
    id: `f${adapters.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    family: familyFromFileName(fileName),
    fileName,
    addedAt: adapters.now(),
  };

  try {
    await store.write(meta.id, bytes);
  } catch {
    return { ok: false, error: { kind: "unreadable", fileName } };
  }

  const fonts = readCustomFonts(adapters.storage);
  writeCustomFonts(adapters.storage, [...fonts, meta]);

  try {
    const face = adapters.fontFace.create(meta.family, bytes);
    await face.load();
    adapters.addFace(face);
  } catch {
    // The bytes are stored; a face that will not load today can still be tried
    // again next launch. The author sees the font in the chooser either way.
  }

  return { ok: true, meta };
}

/**
 * Removes an imported font. If it was the selected one, the selection reverts
 * to the default rather than pointing at a face that no longer exists.
 */
export async function removeCustomFont(
  adapters: CustomFontAdapters,
  id: string,
): Promise<void> {
  const fonts = readCustomFonts(adapters.storage);
  const remaining = fonts.filter((font) => font.id !== id);
  if (remaining.length === fonts.length) return;
  writeCustomFonts(adapters.storage, remaining);

  const store = await adapters.byteStore();
  if (store !== null) {
    try {
      await store.remove(id);
    } catch {
      // Orphaned bytes are untidy, not fatal; the metadata is already gone.
    }
  }

  const storage = adapters.storage;
  if (!storage) return;
  let selected: string | null = null;
  try {
    selected = storage.getItem(FONT_STORAGE_KEY);
  } catch {
    return;
  }
  if (selected === `${CUSTOM_FONT_PREFIX}${id}`) {
    writeStoredFont(storage, DEFAULT_FONT);
  }
}

/**
 * Selects an imported font by writing the raw `custom:<id>` value. The
 * catalogue guard in [[fonts.ts]] deliberately does not know these values; the
 * chooser and the startup loader do.
 */
export function writeStoredCustomFont(
  storage: Pick<Storage, "setItem"> | undefined,
  id: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(FONT_STORAGE_KEY, `${CUSTOM_FONT_PREFIX}${id}`);
  } catch {
    // Not persisted, but honoured for this session.
  }
}

/* -------------------------------------------------------------------------- */
/* Registration at startup                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Registers every stored font with the document, then applies the selection if
 * it names one of them.
 *
 * Fire-and-forget by design: the app must never wait on this to render. A
 * custom face arrives one reflow late, the same trade index.html's pre-paint
 * script already documents for faces it does not know.
 */
export async function loadAndRegisterAllCustomFonts(
  adapters: CustomFontAdapters,
  root: HTMLElement,
): Promise<void> {
  const fonts = readCustomFonts(adapters.storage);
  if (fonts.length === 0) return;

  const store = await adapters.byteStore();
  if (store === null) return;

  let selectedId: string | null = null;
  try {
    const raw = adapters.storage?.getItem(FONT_STORAGE_KEY);
    if (raw !== null && raw !== undefined && isCustomFontValue(raw)) {
      selectedId = customFontId(raw);
    }
  } catch {
    // Storage that throws cannot have a selection worth restoring.
  }

  for (const meta of fonts) {
    let bytes: ArrayBuffer | null = null;
    try {
      bytes = await store.read(meta.id);
    } catch {
      bytes = null;
    }
    if (bytes === null) continue;
    try {
      const face = adapters.fontFace.create(meta.family, bytes);
      await face.load();
      adapters.addFace(face);
      if (meta.id === selectedId) {
        applyCustomFont(root, meta.family);
      }
    } catch {
      // A face that will not load is skipped; the next launch tries again.
    }
  }
}

/**
 * Stamps the custom choice on <html> and sets the prose stack inline.
 *
 * The inline property wins over the attribute rules in tokens.css, which is how
 * a family the stylesheet has never heard of still reaches the manuscript. The
 * fallbacks matter the same way they do for the bundled faces.
 */
export function applyCustomFont(root: HTMLElement, family: string): void {
  root.setAttribute("data-font", "custom");
  root.style.setProperty("--font-prose", `"${family}", Georgia, "Iowan Old Style", serif`);
}

/** Undoes applyCustomFont so a built-in face's stylesheet rule applies again. */
export function clearCustomFont(root: HTMLElement): void {
  root.style.removeProperty("--font-prose");
}

/* -------------------------------------------------------------------------- */
/* Browser adapters                                                            */
/* -------------------------------------------------------------------------- */

const OPFS_FONT_DIRECTORY = ".noveltea-fonts";
const IDB_DATABASE = "noveltea-fonts";
const IDB_STORE = "fonts";

async function opfsByteStore(): Promise<ByteStore | null> {
  try {
    if (typeof navigator === "undefined" || navigator.storage?.getDirectory === undefined) {
      return null;
    }
    const dir = await navigator.storage.getDirectory();
    const fonts = await dir.getDirectoryHandle(OPFS_FONT_DIRECTORY, { create: true });
    return {
      kind: "opfs",
      async write(id, bytes) {
        const handle = await fonts.getFileHandle(id, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      },
      async read(id) {
        try {
          const handle = await fonts.getFileHandle(id);
          const file = await handle.getFile();
          return await file.arrayBuffer();
        } catch {
          return null;
        }
      },
      async remove(id) {
        await fonts.removeEntry(id);
      },
    };
  } catch {
    return null;
  }
}

function idbDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

async function indexedDbByteStore(): Promise<ByteStore | null> {
  try {
    if (typeof indexedDB === "undefined") return null;
    const db = await idbDatabase();
    const run = (
      mode: IDBTransactionMode,
      op: (store: IDBObjectStore) => IDBRequest,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const request = op(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      });
    return {
      kind: "indexeddb",
      async write(id, bytes) {
        await run("readwrite", (store) => store.put(bytes, id));
      },
      async read(id) {
        const result = await run("readonly", (store) => store.get(id));
        return result instanceof ArrayBuffer ? result : null;
      },
      async remove(id) {
        await run("readwrite", (store) => store.delete(id));
      },
    };
  } catch {
    return null;
  }
}

/** OPFS first, IndexedDB when the platform has no OPFS, null when it has neither. */
export async function browserByteStore(): Promise<ByteStore | null> {
  return (await opfsByteStore()) ?? (await indexedDbByteStore());
}

/** The adapters the real app uses; tests build their own. */
export function browserFontAdapters(): CustomFontAdapters {
  return {
    storage: typeof window === "undefined" ? undefined : window.localStorage,
    byteStore: browserByteStore,
    fontFace: {
      create: (family, bytes) => new FontFace(family, bytes),
    },
    addFace: (face) => {
      document.fonts.add(face as FontFace);
    },
    now: () => Date.now(),
  };
}
