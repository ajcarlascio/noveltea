import { useEffect, useRef } from "react";
import "./ConsentDialog.css";

/**
 * The opt-in a network feature has to pass through.
 *
 * Built on the native <dialog> so focus trapping, Escape, the top layer and inert
 * background all come from the browser rather than from a hand-rolled approximation
 * that gets one of them wrong.
 *
 * Two deliberate frictions: the confirming button is not the default focus, and it
 * says what the feature does rather than "OK". Someone dismissing a dialog by reflex
 * should end up with the feature off, because that is the reversible outcome.
 */
export interface ConsentDialogProps {
  open: boolean;
  title: string;
  /** What leaves the device, in plain words. */
  whatIsSent: string;
  /** Who receives it. */
  recipient: string;
  /** Anything else true and material — retention, keys, cost. */
  notes?: string[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConsentDialog({
  open,
  title,
  whatIsSent,
  recipient,
  notes = [],
  confirmLabel,
  onConfirm,
  onCancel,
}: ConsentDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      returnFocusTo.current = document.activeElement;

      // showModal is missing on iOS Safari before 15.4, and in jsdom. Falling back
      // to a plain open dialog loses the focus trap and the inert background — but
      // an unreachable consent dialog means the feature can never be turned on at
      // all, and silently showing nothing is the worse failure by far.
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");

      // Explicitly, rather than via autoFocus: that fires on mount, which happened
      // before the dialog opened. Landing on "Keep it off" is deliberate — see the
      // note on the buttons below.
      declineRef.current?.focus();
    }

    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");

      // showModal restores focus by itself; the fallback path does not, and leaving
      // focus on the body sends a keyboard reader back to the top of the page.
      const previous = returnFocusTo.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      returnFocusTo.current = null;
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="consent"
      aria-labelledby="consent-title"
      // Escape and the backdrop both mean "no". The browser fires `cancel` for
      // Escape; without this the dialog closes while the caller still believes it
      // is open, and the next render reopens it.
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      // The browser only fires `cancel` for a dialog opened with showModal. Where
      // that is missing, Escape has to be handled here or the dialog cannot be
      // dismissed by keyboard at all.
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="consent-title" className="consent__title">
        {title}
      </h2>

      <p className="consent__lede">
        This sends your words off this device. Nothing else in NovelTea does that.
      </p>

      <dl className="consent__facts">
        <dt>What is sent</dt>
        <dd>{whatIsSent}</dd>
        <dt>Where it goes</dt>
        <dd>{recipient}</dd>
      </dl>

      {notes.length > 0 && (
        <ul className="consent__notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <p className="consent__lede">
        You can turn this off at any time in Settings, and you will be asked again
        before it is used after that.
      </p>

      <div className="consent__actions">
        {/* Cancel first, and focused: a reflex dismissal should leave it off. */}
        <button type="button" className="button" ref={declineRef} onClick={onCancel}>
          Keep it off
        </button>
        <button type="button" className="button button--confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
