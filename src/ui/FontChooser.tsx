import { useEffect, useState } from "react";
import {
  applyFont,
  applyFontSize,
  FONT_CHOICES,
  FONT_LABELS,
  FONT_NOTES,
  FONT_SIZE_LABELS,
  FONT_SIZES,
  readStoredFont,
  readStoredFontSize,
  writeStoredFont,
  writeStoredFontSize,
  type FontChoice,
  type FontSize,
} from "@/app/typography/fonts";
import "./FontChooser.css";

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Picks the reading font.
 *
 * No context and no provider: this is the only component that changes the value,
 * and the effect of changing it is a stylesheet attribute rather than React state
 * anything else reads. A provider here would be plumbing without a consumer.
 */
export function FontChooser() {
  const [choice, setChoice] = useState<FontChoice>(() => readStoredFont(safeStorage()));
  const [size, setSize] = useState<FontSize>(() => readStoredFontSize(safeStorage()));

  useEffect(() => {
    applyFont(document.documentElement, choice);
  }, [choice]);

  useEffect(() => {
    applyFontSize(document.documentElement, size);
  }, [size]);

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
