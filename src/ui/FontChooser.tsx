import { useEffect, useRef, useState } from "react";
import {
  applyFont,
  applyFontSize,
  DEFAULT_FONT,
  FONT_CHOICES,
  FONT_LABELS,
  FONT_NOTES,
  FONT_SIZE_LABELS,
  FONT_SIZES,
  FONT_STORAGE_KEY,
  readStoredFont,
  readStoredFontSize,
  writeStoredFont,
  writeStoredFontSize,
  type FontChoice,
  type FontSize,
} from "@/app/typography/fonts";
import {
  applyCustomFont,
  browserFontAdapters,
  clearCustomFont,
  CUSTOM_FONT_PREFIX,
  describeImportError,
  importCustomFont,
  isCustomFontValue,
  readCustomFonts,
  removeCustomFont,
  writeStoredCustomFont,
  type CustomFontAdapters,
  type CustomFontMeta,
  type CustomFontValue,
} from "@/app/typography/customFonts";
import "./FontChooser.css";

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** The selection is either a bundled face or `custom:<id>`. */
type Selection = FontChoice | CustomFontValue;

/**
 * Reads a file's bytes. `file.arrayBuffer()` is the modern path; FileReader is
 * the fallback for engines that predate it (and jsdom, which never got it).
 */
function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(file);
  });
}

function readSelection(storage: Storage | undefined): Selection {
  if (!storage) return DEFAULT_FONT;
  let raw: string | null;
  try {
    raw = storage.getItem(FONT_STORAGE_KEY);
  } catch {
    return DEFAULT_FONT;
  }
  if (raw === null) return DEFAULT_FONT;
  // readStoredFont deliberately does not know custom values — it guards the
  // bundled catalogue — so the custom case is answered before asking it.
  if (isCustomFontValue(raw)) return raw;
  return readStoredFont(storage);
}

/**
 * Picks the reading font.
 *
 * No context and no provider: this is the only component that changes the value,
 * and the effect of changing it is a stylesheet attribute rather than React state
 * anything else reads. A provider here would be plumbing without a consumer.
 *
 * Imported fonts are the one piece of state here that outlives the component:
 * they live in OPFS/IndexedDB plus a metadata list, and the adapters that reach
 * them are injectable so the logic stays testable in jsdom.
 */
export function FontChooser({ adapters = browserFontAdapters() }: { adapters?: CustomFontAdapters }) {
  const [choice, setChoice] = useState<Selection>(() => readSelection(safeStorage()));
  const [size, setSize] = useState<FontSize>(() => readStoredFontSize(safeStorage()));
  const [customFonts, setCustomFonts] = useState<CustomFontMeta[]>(() =>
    readCustomFonts(safeStorage()),
  );
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCustomFontValue(choice)) {
      const meta = customFonts.find((font) => `${CUSTOM_FONT_PREFIX}${font.id}` === choice);
      if (meta !== undefined) applyCustomFont(document.documentElement, meta.family);
    } else {
      clearCustomFont(document.documentElement);
      applyFont(document.documentElement, choice);
    }
  }, [choice, customFonts]);

  useEffect(() => {
    applyFontSize(document.documentElement, size);
  }, [size]);

  async function onFilesChosen(files: FileList | null) {
    setImportError(null);
    if (files === null || files.length === 0) return;
    const errors: string[] = [];
    let lastImported: CustomFontMeta | null = null;
    for (const file of Array.from(files)) {
      let bytes: ArrayBuffer;
      try {
        bytes = await readFileBytes(file);
      } catch {
        errors.push(`“${file.name}” could not be read.`);
        continue;
      }
      const result = await importCustomFont(adapters, file.name, bytes);
      if (result.ok) lastImported = result.meta;
      else errors.push(describeImportError(result.error));
    }
    setCustomFonts(readCustomFonts(safeStorage()));
    if (errors.length > 0) setImportError(errors.join(" "));
    if (lastImported !== null) {
      // Selecting what was just imported is the confirmation that it worked.
      setChoice(`${CUSTOM_FONT_PREFIX}${lastImported.id}`);
      writeStoredCustomFont(safeStorage(), lastImported.id);
    }
    // Let the same file be picked again.
    if (fileInput.current !== null) fileInput.current.value = "";
  }

  async function onRemove(meta: CustomFontMeta) {
    await removeCustomFont(adapters, meta.id);
    setCustomFonts(readCustomFonts(safeStorage()));
    if (choice === `${CUSTOM_FONT_PREFIX}${meta.id}`) {
      setChoice(DEFAULT_FONT);
    }
  }

  return (
    <fieldset className="font-chooser">
      <legend className="font-chooser__legend">Reading font</legend>
      <p className="font-chooser__note">
        Used for your manuscript. The interface keeps its own font.
      </p>
      {FONT_CHOICES.map((option) => (
        <label key={option} className="font-chooser__option" data-font-preview={option}>
          <input
            type="radio"
            name="reading-font"
            value={option}
            checked={choice === option}
            onChange={() => {
              setChoice(option);
              writeStoredFont(safeStorage(), option);
            }}
          />
          <span>
            <span className="font-chooser__name">{FONT_LABELS[option]}</span>
            <span className="font-chooser__note-inline">{FONT_NOTES[option]}</span>
          </span>
        </label>
      ))}

      <div className="font-chooser__custom">
        <span className="font-chooser__size-label">Your fonts</span>
        {customFonts.map((meta) => (
          <span key={meta.id} className="font-chooser__custom-row">
            <label className="font-chooser__option" data-font-preview="custom">
              <input
                type="radio"
                name="reading-font"
                value={`${CUSTOM_FONT_PREFIX}${meta.id}`}
                checked={choice === `${CUSTOM_FONT_PREFIX}${meta.id}`}
                onChange={() => {
                  setChoice(`${CUSTOM_FONT_PREFIX}${meta.id}`);
                  writeStoredCustomFont(safeStorage(), meta.id);
                }}
              />
              <span>
                <span className="font-chooser__name">{meta.family}</span>
                <span className="font-chooser__note-inline">{meta.fileName}</span>
              </span>
            </label>
            <button
              type="button"
              className="button font-chooser__remove"
              aria-label={`Remove ${meta.family}`}
              onClick={() => void onRemove(meta)}
            >
              Remove
            </button>
          </span>
        ))}
        <button
          type="button"
          className="button"
          onClick={() => fileInput.current?.click()}
        >
          Import font…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".woff2,.woff,.otf,.ttf"
          className="font-chooser__file-input"
          onChange={(event) => void onFilesChosen(event.target.files)}
        />
        <p className="font-chooser__note-inline">
          Imported fonts stay on this device only, and you are responsible for the
          font&rsquo;s licence.
        </p>
        {importError !== null && (
          <p className="font-chooser__error" role="alert">
            {importError}
          </p>
        )}
      </div>

      <div className="font-chooser__size">
        <span className="font-chooser__size-label" id="prose-size">
          Size
        </span>
        {/* A radio group rather than a slider: four named sizes an author can return
            to, instead of a value they have to find again. */}
        <div className="font-chooser__sizes" role="radiogroup" aria-labelledby="prose-size">
          {FONT_SIZES.map((option) => (
            <label key={option} className="font-chooser__size-option">
              <input
                type="radio"
                name="reading-size"
                value={option}
                checked={size === option}
                onChange={() => {
                  setSize(option);
                  writeStoredFontSize(safeStorage(), option);
                }}
              />
              <span data-size-preview={option}>{FONT_SIZE_LABELS[option]}</span>
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
