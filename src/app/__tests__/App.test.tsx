import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { DatabaseProvider } from "../db/DatabaseProvider";
import { SettingsProvider } from "../settings/SettingsProvider";
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

function renderAt(path: string) {
  // The projects route reads the local replica, so the shell needs a database.
  // A worker double keeps these tests about routing.
  const client = new DatabaseClient(fakeWorker().worker);
  return render(
    <ThemeProvider>
      <SettingsProvider>
        <DatabaseProvider create={() => client}>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>
        </DatabaseProvider>
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
