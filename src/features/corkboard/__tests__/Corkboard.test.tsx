import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseContext } from "@/app/db/DatabaseContext";
import type { DbStatus } from "@/db/client";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";
import { Corkboard } from "../Corkboard";

/**
 * The board, over a real SQLite replica.
 *
 * The database is not mocked, because everything worth asserting here is what reaches
 * it: that leaving a card writes a synopsis, that a move button writes an order. A
 * double would only show that the component calls itself.
 */

const READY: DbStatus = { state: "ready", storage: "memory", appliedVersions: [], schemaVersion: 11 };

let db: TestDatabase;
let projectId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
});
afterEach(() => db.close());

const folder = (title: string, parentId: string | null = null) =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId, type: "folder", title }).id;

const document = (title: string, parentId: string | null = null) =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId, type: "document", title }).id;

function renderBoard(
  parentId: string | null = null,
  handlers: { onNavigate?: (id: string | null) => void; onOpenDocument?: (id: string) => void } = {},
) {
  const onNavigate = handlers.onNavigate ?? vi.fn();
  const onOpenDocument = handlers.onOpenDocument ?? vi.fn();
  render(
    <DatabaseContext.Provider value={{ db: db.client, status: READY }}>
      <Corkboard
        projectId={projectId}
        parentId={parentId}
        trail={[{ id: null, title: "The Lighthouse" }]}
        onNavigate={onNavigate}
        onOpenDocument={onOpenDocument}
      />
    </DatabaseContext.Provider>,
  );
  return { onNavigate, onOpenDocument };
}

const synopsisOf = (id: string): string | null =>
  db.adapter.query<{ synopsis: string | null }>("SELECT synopsis FROM document WHERE id = ?;", [
    id,
  ])[0]?.synopsis ?? null;

const titlesInOrder = () =>
  screen.getAllByRole("listitem").map((card) => within(card).getByRole("heading").textContent);

describe("what the board shows", () => {
  it("puts a card up for every document and folder at this level", async () => {
    folder("Act One");
    document("Scene One");

    renderBoard();

    expect(await screen.findByRole("heading", { name: /Act One/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Scene One/ })).toBeInTheDocument();
  });

  it("shows a document's summary and its length", async () => {
    const id = document("Scene One");
    db.adapter.run("UPDATE document SET synopsis = ?, word_count = ? WHERE id = ?;", [
      "She climbs the tower.",
      412,
      id,
    ]);

    renderBoard();

    expect(await screen.findByDisplayValue("She climbs the tower.")).toBeInTheDocument();
    expect(screen.getByText("412 words")).toBeInTheDocument();
  });

  it("says what is behind a folder, which has no summary of its own", async () => {
    const act = folder("Act One");
    document("Scene One", act);
    document("Scene Two", act);

    renderBoard();

    expect(await screen.findByText("2 items")).toBeInTheDocument();
  });

  it("says plainly when a level is empty rather than showing an empty board", async () => {
    renderBoard();
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });
});

describe("writing a card", () => {
  it("saves what was typed when the author leaves the field", async () => {
    const id = document("Scene One");
    renderBoard();
    const field = await screen.findByLabelText("Synopsis of Scene One");

    await userEvent.type(field, "She climbs the tower and finds the lamp cold.");
    await userEvent.tab();

    await waitFor(() =>
      expect(synopsisOf(id)).toBe("She climbs the tower and finds the lamp cold."),
    );
  });

  it("writes nothing when the field was only looked at", async () => {
    // Every save is a queue entry the next sync has to carry. Tabbing through a board
    // of forty cards should not enqueue forty documents.
    const id = document("Scene One");
    db.adapter.run("UPDATE document SET synopsis = ? WHERE id = ?;", ["Unchanged.", id]);
    db.adapter.run("DELETE FROM pending_change;");
    renderBoard();

    await userEvent.click(await screen.findByLabelText("Synopsis of Scene One"));
    await userEvent.tab();

    expect(
      db.adapter.query<{ n: number }>("SELECT COUNT(*) AS n FROM pending_change;")[0]?.n,
    ).toBe(0);
  });

  it("clears a card that was emptied", async () => {
    const id = document("Scene One");
    db.adapter.run("UPDATE document SET synopsis = ? WHERE id = ?;", ["To be deleted.", id]);
    renderBoard();

    await userEvent.clear(await screen.findByLabelText("Synopsis of Scene One"));
    await userEvent.tab();

    await waitFor(() => expect(synopsisOf(id)).toBeNull());
  });

  it("offers no field on a folder, because there is no row to put one in", async () => {
    folder("Act One");
    renderBoard();

    await screen.findByRole("heading", { name: /Act One/ });
    expect(screen.queryByLabelText("Synopsis of Act One")).not.toBeInTheDocument();
  });
});

describe("rearranging", () => {
  it("moves a card one place earlier", async () => {
    document("First");
    document("Second");
    renderBoard();

    await screen.findByRole("heading", { name: /First/ });
    await userEvent.click(screen.getByRole("button", { name: "Move Second earlier" }));

    await waitFor(() => expect(titlesInOrder()).toEqual(["Second", "First"]));
  });

  it("moves a card one place later", async () => {
    document("First");
    document("Second");
    renderBoard();

    await screen.findByRole("heading", { name: /First/ });
    await userEvent.click(screen.getByRole("button", { name: "Move First later" }));

    await waitFor(() => expect(titlesInOrder()).toEqual(["Second", "First"]));
  });

  it("has nothing to press at either end", async () => {
    document("First");
    document("Second");
    renderBoard();

    await screen.findByRole("heading", { name: /First/ });
    expect(screen.getByRole("button", { name: "Move First earlier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Second later" })).toBeDisabled();
  });

  it("keeps the new order in the binder, not only on the board", async () => {
    const first = document("First");
    const second = document("Second");
    renderBoard();

    await screen.findByRole("heading", { name: /First/ });
    await userEvent.click(screen.getByRole("button", { name: "Move Second earlier" }));

    await waitFor(() => {
      const rows = db.adapter.query<{ id: string }>(
        "SELECT id FROM binder_item WHERE project_id = ? AND type = 'document' ORDER BY order_key;",
        [projectId],
      );
      expect(rows.map((row) => row.id)).toEqual([second, first]);
    });
  });
});

describe("getting somewhere from a card", () => {
  it("drills into a folder", async () => {
    const act = folder("Act One");
    const onNavigate = vi.fn();
    renderBoard(null, { onNavigate });

    // Scoped to the heading: the move buttons are named after the card too, so a
    // name match alone finds three things.
    const heading = await screen.findByRole("heading", { name: /Act One/ });
    await userEvent.click(within(heading).getByRole("button"));

    expect(onNavigate).toHaveBeenCalledWith(act);
  });

  it("opens a document, because a card is a way into the scene and not only a label", async () => {
    const id = document("Scene One");
    const onOpenDocument = vi.fn();
    renderBoard(null, { onOpenDocument });

    const heading = await screen.findByRole("heading", { name: /Scene One/ });
    await userEvent.click(within(heading).getByRole("button"));

    expect(onOpenDocument).toHaveBeenCalledWith(id);
  });
});
