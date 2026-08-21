import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { SignIn } from "@/features/auth/SignIn";
import { useAuth } from "@/features/auth/AuthContext";
import { NotFound } from "./routes/NotFound";
import { Project } from "./routes/Project";
import { Projects } from "./routes/Projects";
import { Settings } from "./routes/Settings";
import "./App.css";

export function App() {
  const { session, signOut } = useAuth();

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
      <main className="shell__main" id="main" tabIndex={-1}>
        {/* No guard, deliberately. The replica is complete and local, so an author
            can write before they have a server — on a plane, or before they have set
            one up at all. Signing in is what connects that work to a server, not what
            unlocks the app. Requiring it first would contradict the one rule this
            client is built on: the interface never waits on the network to render. */}
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<Project />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
