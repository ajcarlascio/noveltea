import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { MINIMUM_PASSWORD_LENGTH } from "./passwords";
import "./SignIn.css";

/**
 * Choosing a password, either because it is time to or because the server insists.
 *
 * The insisting case is what this exists for. A freshly installed instance creates its
 * administrator with a password nobody chose, and an account an administrator creates has
 * one that administrator knows — in both cases the server refuses every route but this one
 * until it is replaced. Nothing here enforces that; it is the screen for a rule the API
 * already applies, which is the only place a rule like this can actually hold.
 *
 * Deliberately not the emailed reset. That needs a mail server, and a home instance
 * usually has none — its reset links go to a log file the account holder cannot read.
 */
export function ChangePassword() {
  const { session, changePassword } = useAuth();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState<number | null>(null);

  // The request outlives the click. Someone who submits and immediately navigates to
  // their manuscript leaves it in flight, and its result has nowhere to land.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const required = session?.mustChangePassword === true;

  if (session === null) {
    return (
      <section className="page signin">
        <h1>Choose a password</h1>
        <p className="page__note">
          Sign in first — this changes the password of the account you are signed in as.
        </p>
        <Link className="button" to="/signin">
          Sign in
        </Link>
      </section>
    );
  }

  if (signedOut !== null) {
    return (
      <section className="page signin">
        <h1>Password changed</h1>
        <p className="page__note">
          {signedOut === 0
            ? "No other devices were signed in."
            : `Signed out ${String(signedOut)} other ${signedOut === 1 ? "device" : "devices"}. ` +
              "Sign in again on each with the new password."}
        </p>
        <Link className="button button--confirm" to="/projects">
          Continue
        </Link>
      </section>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    // Checked here so a typo costs nothing, and again by the server, which is what
    // actually decides. The confirmation field is only ever a client-side idea: there is
    // nothing to send it to.
    if (next !== confirmation) {
      setError("The two new passwords do not match.");
      return;
    }
    if (next.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`Use at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`);
      return;
    }
    if (next === current) {
      setError("Choose a password different from the current one.");
      return;
    }

    setBusy(true);
    changePassword(current, next)
      .then((devices) => {
        if (onScreen.current) setSignedOut(devices);
      })
      .catch((cause: unknown) => {
        if (!onScreen.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (onScreen.current) setBusy(false);
      });
  };

  return (
    <section className="page signin">
      <h1>{required ? "Choose your password" : "Change your password"}</h1>
      <p className="page__note">
        {required
          ? `The password on ${session.email} was set by whoever installed this server, ` +
            "so it is not yours yet. Choose one nobody else has seen — until you do, this " +
            "account cannot do anything else."
          : `Changing the password for ${session.email}. Every other device signed in as ` +
            "this account will be signed out."}
      </p>

      <form className="signin__form" onSubmit={onSubmit}>
        <label className="signin__field">
          <span>Current password</span>
          <input
            name="currentPassword"
            type="password"
            value={current}
            autoComplete="current-password"
            required
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>

        {/* The hint is described-by rather than inside the label: a label's text is the
            field's accessible name, and "New password At least 12 characters. A phrase you
            can remember beats..." is not a name anybody wants read out to them. */}
        <div className="signin__field">
          <label htmlFor="newPassword">
            <span>New password</span>
          </label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            value={next}
            autoComplete="new-password"
            aria-describedby="newPasswordHint"
            required
            onChange={(event) => setNext(event.target.value)}
          />
          <span className="signin__hint" id="newPasswordHint">
            At least {MINIMUM_PASSWORD_LENGTH} characters. A phrase you can remember beats a
            short word with punctuation in it.
          </span>
        </div>

        <label className="signin__field">
          <span>New password again</span>
          <input
            name="confirmPassword"
            type="password"
            value={confirmation}
            autoComplete="new-password"
            required
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>

        {error !== null && (
          <p className="signin__error" role="alert">
            {error}
          </p>
        )}

        <div className="signin__actions">
          <button type="submit" className="button button--confirm" disabled={busy}>
            {busy ? "Working" : "Change password"}
          </button>
          {!required && (
            <Link className="button" to="/settings">
              Cancel
            </Link>
          )}
        </div>
      </form>
    </section>
  );
}
