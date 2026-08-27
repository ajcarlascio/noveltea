import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { Users } from "@/features/admin/Users";
import { ChangePassword } from "@/features/auth/ChangePassword";
import { SignIn } from "@/features/auth/SignIn";
import { useAuth } from "@/features/auth/AuthContext";
import { NotFound } from "./routes/NotFound";
import { Project } from "./routes/Project";
import { Projects } from "./routes/Projects";
import { Settings } from "./routes/Settings";
import "./App.css";

export function App() {
  const { session, signOut } = useAuth();

  /**
   * The server is holding this account until it picks a password of its own.
   *
   * What that changes here is where signing in lands and what the header says — not what
   * the app will let anyone do. The manuscripts are in a local replica and they belong to
   * the author whether or not a server is happy with them, so locking the editor over a
   * server-side account state would break the one rule this client is built on for a rule
   * it does not enforce anyway. The API refuses every route but the change itself, which
   * is where a rule like this can actually hold.
   */
  const mustChangePassword = session?.mustChangePassword === true;
  const landing = mustChangePassword ? "/account/password" : "/projects";

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="shell__bar">
        <span className="shell__brand">NovelTea</span>
        <nav className="shell__nav">
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          {/* Offered only to an account the server said administers it. A hint about what
              to show, never a permission: the API re-reads the flag on every call, so
              faking it produces a screen that answers 404. */}
          {session?.isAdmin === true && <NavLink to="/admin">Accounts</NavLink>}
        </nav>
        <span className="shell__account">
          {session === null ? (
            <NavLink to="/signin" className="button" aria-label="Sign in to sync">
              <span className="button__long">Sign in to sync</span>
              <span className="button__short" aria-hidden="true">
                Sign in
              </span>
            </NavLink>
          ) : (
            <>
              <span className="shell__who" title={session.serverUrl}>
                {session.email}
              </span>
              <button type="button" className="button" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </span>
      </header>
      {mustChangePassword && (
        <p className="shell__banner" role="alert">
          <span>
            The password on this account was chosen by whoever set up this server, so it
            cannot sync until you replace it.
          </span>
          <NavLink to="/account/password" className="button button--confirm">
            Choose a password
          </NavLink>
        </p>
      )}
      <main className="shell__main" id="main" tabIndex={-1}>
        {/* No guard, deliberately. The replica is complete and local, so an author
            can write before they have a server — on a plane, or before they have set
            one up at all. Signing in is what connects that work to a server, not what
            unlocks the app. Requiring it first would contradict the one rule this
            client is built on: the interface never waits on the network to render. */}
        <Routes>
          <Route path="/" element={<Navigate to={landing} replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<Project />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/account/password" element={<ChangePassword />} />
          <Route path="/admin" element={<Users />} />
          {/* The redirect lives here rather than inside SignIn so the form stays a form:
              it renders in a test without a router, and routing decisions stay with the
              router. Signing in on a first-run account lands on the password screen,
              which is what "forced" amounts to on this side of the wire. */}
          <Route
            path="/signin"
            element={session === null ? <SignIn /> : <Navigate to={landing} replace />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
