import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { createUser, listUsers, setPassword, type AdminUser, type NewAccount } from "./api";
import "./Admin.css";

/**
 * The accounts on this server.
 *
 * Exists because self-registration is closed by default: on a self-hosted instance an
 * account comes from whoever runs the server, and `curl` is not a way to invite somebody
 * to write a novel.
 *
 * Loads its list after rendering rather than before it, like everything else here — the
 * interface never waits on the network to appear. Unlike the rest of the app there is no
 * local replica to fall back on, so the empty state has to say plainly that this screen
 * needs the server, rather than looking like an instance with no accounts on it.
 */
export function Users() {
  const { session, authenticator } = useAuth();

  /**
   * Whether this screen is still on screen.
   *
   * Every call here is a request that outlives the click that started it, and somebody
   * who opens Accounts and immediately goes back to their manuscript leaves one in
   * flight. Landing its result on a tree that is gone is at best wasted work and at worst
   * — as it turned out under test — an exception thrown from inside React's scheduler,
   * far enough from the cause to be unrecognisable.
   */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  /** Shown once and never again: only the hash of it reaches the database. */
  const [issued, setIssued] = useState<(NewAccount & { reset: boolean }) | null>(null);

  const reload = useCallback(() => {
    if (authenticator === null) return;
    listUsers(authenticator)
      .then((loaded) => {
        if (!onScreen.current) return;
        setUsers(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!onScreen.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [authenticator]);

  useEffect(reload, [reload]);

  if (session === null || authenticator === null) {
    return (
      <section className="page">
        <h1>Accounts</h1>
        <p className="page__note">Sign in to the server you administer to manage its accounts.</p>
        <Link className="button" to="/signin">
          Sign in
        </Link>
      </section>
    );
  }

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIssued(null);
    setBusy(true);
    createUser(authenticator, {
      email: email.trim(),
      ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
      admin: makeAdmin,
    })
      .then((account) => {
        if (!onScreen.current) return;
        setIssued({ ...account, reset: false });
        setEmail("");
        setDisplayName("");
        setMakeAdmin(false);
        reload();
      })
      .catch((cause: unknown) => {
        if (!onScreen.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (onScreen.current) setBusy(false);
      });
  };

  const onResetPassword = (user: AdminUser) => {
    setError(null);
    setIssued(null);
    setBusy(true);
    setPassword(authenticator, user.id)
      .then((account) => {
        if (!onScreen.current) return;
        setIssued({ ...account, reset: true });
        reload();
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
    <section className="page admin">
      <h1>Accounts</h1>
      <p className="page__note">
        Accounts on <strong>{session.serverUrl}</strong>. Administering this server does not
        give you access to anyone&rsquo;s projects or documents.
      </p>

      {error !== null && (
        <p className="signin__error" role="alert">
          {error}
        </p>
      )}

      {issued !== null && (
        <div className="admin__issued" role="status">
          <h2>{issued.reset ? "New password for" : "Account created:"} {issued.email}</h2>
          <p className="admin__password">{issued.password}</p>
          <p className="signin__hint">
            Copy this now — the server keeps only a hash of it and cannot show it again.
            Whoever uses it will have to choose their own password before they can do
            anything else.
          </p>
        </div>
      )}

      <form className="signin__form admin__create" onSubmit={onCreate}>
        <h2>Add someone</h2>
        <label className="signin__field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            value={email}
            autoComplete="off"
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="signin__field">
          <span>Display name</span>
          <input
            name="displayName"
            value={displayName}
            autoComplete="off"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="admin__check">
          <input
            name="admin"
            type="checkbox"
            checked={makeAdmin}
            onChange={(event) => setMakeAdmin(event.target.checked)}
          />
          <span>Can administer this server</span>
        </label>
        <div className="signin__actions">
          <button type="submit" className="button button--confirm" disabled={busy}>
            {busy ? "Working" : "Create account"}
          </button>
        </div>
        <p className="signin__hint">
          A password is generated and shown once. There is no invitation email to rely on:
          send it however you already talk to this person.
        </p>
      </form>

      <h2>On this server</h2>
      {users === null ? (
        <p className="page__note">
          {error === null ? "Loading accounts…" : "Could not read the account list."}
        </p>
      ) : (
        <ul className="admin__users">
          {users.map((user) => (
            <li key={user.id} className="admin__user">
              <span className="admin__who">
                <strong>{user.email}</strong>
                {user.displayName !== null && <span> — {user.displayName}</span>}
              </span>
              <span className="admin__badges">
                {user.admin && <span className="admin__badge">administrator</span>}
                {user.guest && <span className="admin__badge">guest</span>}
                {user.mustChangePassword && (
                  <span className="admin__badge admin__badge--pending">
                    has not chosen a password
                  </span>
                )}
                {user.deletionRequestedAt !== null && (
                  <span className="admin__badge admin__badge--pending">deletion scheduled</span>
                )}
              </span>
              {!user.guest && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => onResetPassword(user)}
                >
                  Set a password
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
