import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { NotFound } from "./routes/NotFound";
import { Projects } from "./routes/Projects";
import { Settings } from "./routes/Settings";
import "./App.css";

export function App() {
  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__brand">NovelTea</span>
        <nav className="shell__nav">
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="shell__main">
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
