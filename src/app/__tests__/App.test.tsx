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

describe("an account the server is holding until it picks a password", () => {
  const HELD: Session = { ...SESSION, mustChangePassword: true };

  it("lands there instead of the projects list", () => {
    renderAt("/", HELD);
    expect(screen.getByRole("heading", { name: "Choose your password" })).toBeInTheDocument();
  });

  it("lands there after signing in, which is what forced amounts to on this side", () => {
    // The redirect lives in the router rather than in SignIn, so the form stays a form.
    renderAt("/signin", HELD);
    expect(screen.getByRole("heading", { name: "Choose your password" })).toBeInTheDocument();
  });

  it("says why, above everything, without being a modal", () => {
    renderAt("/projects", HELD);
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot sync until you replace it/i);
  });

  it("still opens the binder, because the manuscripts are local and are the author's", () => {
    // The server refuses every route but the change itself. Locking the editor too would
    // break the rule this client is built on, to enforce something it does not enforce.
    renderAt("/projects", HELD);
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });

  it("says nothing of the kind for an ordinary account", () => {
    renderAt("/projects");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the administration screen", () => {
  it("is offered only to an account the server said administers it", () => {
    renderAt("/projects", { ...SESSION, isAdmin: true });
    expect(screen.getByRole("link", { name: "Accounts" })).toBeInTheDocument();
  });

  it("is not offered to an ordinary account, or to nobody", () => {
    renderAt("/projects");
    expect(screen.queryByRole("link", { name: "Accounts" })).not.toBeInTheDocument();
    renderAt("/projects", null);
    expect(screen.queryByRole("link", { name: "Accounts" })).not.toBeInTheDocument();
  });

  it("is reachable by address even so, because the flag is a hint and not a permission", () => {
    // Faking it in storage produces a screen the API answers 404 to, which is the point:
    // nothing here is the check.
    renderAt("/admin");
    expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
  });
});
