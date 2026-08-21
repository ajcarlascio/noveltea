import type { ReactNode } from "react";

/**
 * A toolbar button that shortens its label on a narrow screen.
 *
 * The accessible name is always the full wording — `aria-label` carries it — so a
 * screen reader and a test both hear "Move to trash" whatever the screen is doing.
 * Only the visible text changes, which is what keeps five actions inside two rows on
 * a phone without abbreviating them for everyone.
 */
export function ToolbarButton({
  label,
  short,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  /** Shown instead of `label` on narrow screens. Defaults to `label`. */
  short?: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
}): ReactNode {
  return (
    <button
      type="button"
      className={variant === "danger" ? "button button--danger" : "button"}
      aria-label={label}
      disabled={disabled ?? false}
      onClick={onClick}
    >
      <span className="button__long">{label}</span>
      <span className="button__short" aria-hidden="true">
        {short ?? label}
      </span>
    </button>
  );
}
