import { useEffect, useState } from "react";
import {
  applyFont,
  FONT_CHOICES,
  FONT_LABELS,
  readStoredFont,
  writeStoredFont,
  type FontChoice,
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

  useEffect(() => {
    applyFont(document.documentElement, choice);
  }, [choice]);

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
          <span>{FONT_LABELS[option]}</span>
        </label>
      ))}
    </fieldset>
  );
}
