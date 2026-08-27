import type { ReactNode } from "react";

/**
 * A toolbar button that shortens its label on a narrow screen.
 *
 * The accessible name is always the full wording — `aria-label` carries it — so a
 * screen reader and a test both hear "Move to trash" whatever the screen is doing.
 * Only the visible text changes, which is what keeps five actions inside two rows on
 * a phone without abbreviating them for everyone.
 *
 * With an `icon`, a phone shows the icon instead of even the short word: six
 * one-word buttons still wrap, and a glyph is narrower than any of them. The icon
 * is decoration — `aria-hidden`, never the accessible name — so it must only ever
 * stand in for a label that is still spoken in full.
 */
export function ToolbarButton({
  label,
  short,
  icon,
  onClick,
  disabled,
  variant,
  pressed,
}: {
  label: string;
  /** Shown instead of `label` on narrow screens. Defaults to `label`. */
  short?: string;
  /** Shown instead of both labels on narrow screens, when present. */
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
  /**
   * Marks a button that turns something on and leaves it on.
   *
   * `aria-pressed` rather than a styling flag, because that is the difference a screen
   * reader has to hear: "Corkboard, toggle button, pressed" is the whole state of the
   * view, and a class name says none of it. The stylesheet hangs off the same attribute,
   * so the two can never drift apart.
   */
  pressed?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className={
        variant === "danger"
          ? `button button--danger${icon ? " button--icon" : ""}`
          : `button${icon ? " button--icon" : ""}`
      }
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      disabled={disabled ?? false}
      onClick={onClick}
    >
      <span className="button__long">{label}</span>
      <span className="button__short" aria-hidden="true">
        {short ?? label}
      </span>
      {icon !== undefined && (
        <span className="button__icon" aria-hidden="true">
          {icon}
        </span>
      )}
    </button>
  );
}
