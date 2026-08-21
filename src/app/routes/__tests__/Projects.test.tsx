import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatabaseProvider } from "@/app/db/DatabaseProvider";
import { DatabaseClient } from "@/db/client";
import { fakeWorker } from "@/test/worker";
import { Projects } from "../Projects";

function renderProjects() {
  const fake = fakeWorker();
  const client = new DatabaseClient(fake.worker);
  render(
    <DatabaseProvider create={() => client}>
      <Projects />
    </DatabaseProvider>,
  );
  return fake;
}

const row = (id: string, title: string) => ({
  id,
  title,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

describe("Projects", () => {
  it("renders the heading before the database has answered", () => {
    // No spinner and no blank screen: the read is local and resolves in
    // milliseconds, so the page is simply there and fills in.
    renderProjects();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });

  it("lists what the replica returns", async () => {
    const fake = renderProjects();
    await act(async () => {
      fake.answerAll([row("p1", "The Lighthouse"), row("p2", "Salt")]);
      await Promise.resolve();
    });
    expect(screen.getByText("The Lighthouse")).toBeInTheDocument();
    expect(screen.getByText("Salt")).toBeInTheDocument();
  });

  it("says so plainly when there is nothing yet", async () => {
    const fake = renderProjects();
    await act(async () => {
      fake.answerAll([]);
      await Promise.resolve();
    });
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("does not claim the replica is empty before it has answered", () => {
    // "No projects yet" while the read is still outstanding tells an author their
    // work is gone. The empty state waits for an actual empty result.
    renderProjects();
    expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument();
  });

  it("reports a failed read instead of showing an empty list", async () => {
    const fake = renderProjects();
    await act(async () => {
      for (const request of fake.sent.splice(0, fake.sent.length)) {
        fake.reply({
          id: request.id,
          ok: false,
          error: { name: "SQLite3Error", message: "no such table: project" },
        });
      }
      await Promise.resolve();
    });
    expect(screen.getByText(/could not read your projects/i)).toBeInTheDocument();
    expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument();
  });
});
