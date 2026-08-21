import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { DatabaseProvider } from "../db/DatabaseProvider";
import { SettingsProvider } from "../settings/SettingsProvider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { Session } from "@/features/auth/session";
import { DatabaseClient } from "@/db/client";
import { fakeWorker } from "@/test/worker";
import { ThemeProvider } from "../theme/ThemeProvider";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
});

const SESSION: Session = {
  serverUrl: "https://write.example.com",
  userId: "u1",
  deviceId: "d1",
  refreshToken: "r",
  email: "author@example.com",
};

function renderAt(path: string, session: Session | null = SESSION) {
  // The projects route reads the local replica, so the shell needs a database.
  // A worker double keeps these tests about routing.
  const client = new DatabaseClient(fakeWorker().worker);
  return render(
    <ThemeProvider>
      <SettingsProvider>
        <AuthProvider initialSession={session}>
          <DatabaseProvider create={() => client}>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>
          </DatabaseProvider>
        </AuthProvider>
      </SettingsProvider>
    </ThemeProvider>,
  );
}

describe("App routing", () => {
  it("redirects the root path to the projects list", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });

  it("renders settings", () => {
    renderAt("/settings");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Appearance" })).toBeInTheDocument();
  });

  it("shows a recoverable page for an unknown path instead of a blank screen", () => {
    renderAt("/projects/does-not-exist/deep/link");
    expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to your projects/i })).toHaveAttribute(
      "href",
      "/projects",
    );
  });

  it("marks the current section in the navigation", () => {
    renderAt("/settings");
    const nav = screen.getByRole("navigation");
    const active = [...nav.querySelectorAll("a.active")].map((a) => a.textContent);
    expect(active).toEqual(["Settings"]);
  });
});

describe("when nobody is signed in", () => {
  it("still opens the binder, because the work is local", () => {
    // The replica is complete without a server. Making an author name one before
    // they can write would contradict the rule the whole client is built on.
    renderAt("/projects", null);
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });

  it("offers signing in as a way to sync, not as a gate", () => {
    renderAt("/projects", null);
    expect(screen.getByRole("link", { name: /sign in to sync/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("reaches the sign-in screen on request", () => {
    renderAt("/signin", null);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("still lets settings be reached", () => {
    renderAt("/settings", null);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("when signed in", () => {
  it("shows who, and where", () => {
    renderAt("/projects");
    expect(screen.getByText("author@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign in to sync/i })).not.toBeInTheDocument();
  });
});
