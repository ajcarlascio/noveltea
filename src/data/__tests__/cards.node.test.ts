// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import {
  afterIdForDropBefore,
  afterIdForMoveEarlier,
  afterIdForMoveLater,
  loadCards,
  type IndexCard,
} from "@/data/cards";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * The corkboard's data, against a real SQLite replica.
 *
 * The reordering helpers are pure and tested as such; everything else goes through the
 * commands and the migrations that ship, because what is worth pinning is that a card
 * edit is an ordinary local write — a row, and a queue entry — and a mocked layer would
 * only prove the code agrees with itself.
 */

let db: TestDatabase;
let projectId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  db.adapter.run("DELETE FROM pending_change;");
});
afterEach(() => db.close());

const folder = (title: string, parentId: string | null = null) =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId, type: "folder", title }).id;

const document = (title: string, parentId: string | null = null) =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId, type: "document", title }).id;

const queued = () =>
  db.adapter.query<{ entity_type: string; entity_id: string; payload: string | null }>(
    "SELECT entity_type, entity_id, payload FROM pending_change ORDER BY id;",
  );

const payloadFor = (id: string): Record<string, unknown> => {
  const row = queued().find((entry) => entry.entity_id === id && entry.entity_type === "document");
  if (!row?.payload) throw new Error(`nothing queued for ${id}`);
  return JSON.parse(row.payload) as Record<string, unknown>;
};

// ---------------------------------------------------------------- reading

describe("loadCards", () => {
  it("reads one level, not a tree, because a wall of every scene is not a board", async () => {
    const act = folder("Act One");
    document("Scene One", act);
    document("Scene Two", act);
    folder("Act Two");

    const top = await loadCards(db, projectId, null);
    expect(top.map((card) => card.title)).toEqual(["Act One", "Act Two"]);

    const inside = await loadCards(db, projectId, act);
    expect(inside.map((card) => card.title)).toEqual(["Scene One", "Scene Two"]);
  });

  it("gives a document its summary and its length", async () => {
    const id = document("Scene One");
    db.adapter.run("UPDATE document SET synopsis = ?, word_count = ? WHERE id = ?;", [
      "She climbs the tower.",
      412,
      id,
    ]);

    const [card] = await loadCards(db, projectId, null);
    expect(card).toMatchObject({
      type: "document",
      synopsis: "She climbs the tower.",
      wordCount: 412,
      childCount: null,
    });
  });

  it("gives a folder what is behind it instead, since it has no summary of its own", async () => {
    const act = folder("Act One");
    document("Scene One", act);
    document("Scene Two", act);

    const [card] = await loadCards(db, projectId, null);
    expect(card).toMatchObject({ type: "folder", childCount: 2, synopsis: null, wordCount: null });
  });

  it("orders by the key the binder orders by, so the two views agree", async () => {
    const first = document("First");
    const second = document("Second");
    COMMANDS.moveBinderItem(db.adapter, { projectId, id: second, parentId: null, afterId: null });

    expect((await loadCards(db, projectId, null)).map((card) => card.id)).toEqual([second, first]);
  });

  it("shows nothing that is in the trash, and no trash node either", async () => {
    const kept = document("Kept");
    const gone = document("Trashed");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: gone });

    const cards = await loadCards(db, projectId, null);
    expect(cards.map((card) => card.id)).toEqual([kept]);
    expect(cards.map((card) => card.type)).not.toContain("trash");
  });

  it("is empty for a folder with nothing in it rather than falling back to the root", async () => {
    document("At the top level");
    const empty = folder("Empty");

    expect(await loadCards(db, projectId, empty)).toEqual([]);
  });
});

// ------------------------------------------------------------- reordering

describe("where a dragged card lands", () => {
  const cards = (...ids: string[]): IndexCard[] =>
    ids.map((id) => ({
      id,
      type: "document",
      title: id,
      orderKey: id,
      synopsis: null,
      wordCount: 0,
      childCount: null,
      labelId: null,
      statusId: null,
    }));

  it("puts a card in front of the one it was dropped on", () => {
    expect(afterIdForDropBefore(cards("a", "b", "c", "d"), "d", "c")).toBe("b");
  });

  it("makes it first when dropped on the first card", () => {
    expect(afterIdForDropBefore(cards("a", "b", "c"), "c", "a")).toBeNull();
  });

  it("measures with the dragged card already removed, or moving right does nothing", () => {
    // Without taking "b" out first, this answers "b" — put b after b — and the card
    // stays exactly where it was, which looks like a broken drag rather than a no-op.
    expect(afterIdForDropBefore(cards("a", "b", "c"), "b", "c")).toBe("a");
  });
});

describe("moving one place at a time", () => {
  const cards = (...ids: string[]): IndexCard[] =>
    ids.map((id) => ({
      id,
      type: "document",
      title: id,
      orderKey: id,
      synopsis: null,
      wordCount: 0,
      childCount: null,
      labelId: null,
      statusId: null,
    }));

  it("moves earlier by following the card two places back", () => {
    expect(afterIdForMoveEarlier(cards("a", "b", "c", "d"), "c")).toBe("a");
  });

  it("becomes the first card when it was second", () => {
    // null and undefined are different answers here: null means "go to the front",
    // undefined means "there is nowhere to go".
    expect(afterIdForMoveEarlier(cards("a", "b", "c"), "b")).toBeNull();
  });

  it("has nowhere to go from either end", () => {
    expect(afterIdForMoveEarlier(cards("a", "b"), "a")).toBeUndefined();
    expect(afterIdForMoveLater(cards("a", "b"), "b")).toBeUndefined();
  });

  it("moves later by following the card in front of it", () => {
    expect(afterIdForMoveLater(cards("a", "b", "c"), "a")).toBe("b");
  });
});

// ---------------------------------------------------------------- writing

describe("saveSynopsis", () => {
  it("writes the card and queues it for sync, so an offline edit is not local-only", () => {
    const id = document("Scene One");

    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "She climbs the tower." });

    expect(
      db.adapter.query<{ synopsis: string }>("SELECT synopsis FROM document WHERE id = ?;", [id])[0]
        ?.synopsis,
    ).toBe("She climbs the tower.");
    expect(payloadFor(id).synopsis).toBe("She climbs the tower.");
  });

  it("treats a blank card as no card at all", () => {
    const id = document("Scene One");
    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "temporary" });

    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "   " });

    // Stored as null, so "is there a summary?" is one question everywhere rather than
    // two that can disagree.
    expect(
      db.adapter.query<{ synopsis: string | null }>(
        "SELECT synopsis FROM document WHERE id = ?;",
        [id],
      )[0]?.synopsis,
    ).toBeNull();
    expect(payloadFor(id).synopsis).toBeNull();
  });

  it("trims, because a trailing newline is not part of anybody's summary", () => {
    const id = document("Scene One");
    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "  She climbs.\n" });
    expect(payloadFor(id).synopsis).toBe("She climbs.");
  });

  it("refuses to write through a folder, or into another project", () => {
    const act = folder("Act One");
    expect(() => COMMANDS.saveSynopsis(db.adapter, { projectId, id: act, synopsis: "x" })).toThrow(
      /not a document/i,
    );

    const other = COMMANDS.createProject(db.adapter, { title: "Another Book" }).id;
    const mine = document("Scene One");
    expect(() =>
      COMMANDS.saveSynopsis(db.adapter, { projectId: other, id: mine, synopsis: "x" }),
    ).toThrow();
  });
});

describe("the one queue entry a document gets", () => {
  it("carries the whole row, because a second edit replaces the payload outright", () => {
    // pending_change holds at most one entry per entity and merging replaces rather
    // than combines. So a partial payload is a promise that no other pane will write
    // this document before the queue drains — and the editor and the corkboard both do.
    const id = document("Scene One");
    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "She climbs the tower." });

    COMMANDS.saveDocument(db.adapter, {
      projectId,
      id,
      content: { type: "doc", content: [] },
      searchText: "the lamp was cold",
      wordCount: 4,
    });

    const payload = payloadFor(id);
    expect(payload.search_text).toBe("the lamp was cold");
    expect(payload.synopsis)
      .toBe("She climbs the tower.");
  });

  it("keeps the prose when the synopsis is written second", () => {
    const id = document("Scene One");
    COMMANDS.saveDocument(db.adapter, {
      projectId,
      id,
      content: { type: "doc", content: [] },
      searchText: "the lamp was cold",
      wordCount: 4,
    });

    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "She climbs the tower." });

    const payload = payloadFor(id);
    expect(payload.synopsis).toBe("She climbs the tower.");
    expect(payload.search_text).toBe("the lamp was cold");
    expect(payload.word_count).toBe(4);
    // Content is sent as JSON, not as the string it is stored as: the server parses it.
    expect(payload.content).toEqual({ type: "doc", content: [] });
  });

  it("leaves exactly one entry behind, whichever order the two panes wrote in", () => {
    const id = document("Scene One");
    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "First thought." });
    COMMANDS.saveDocument(db.adapter, {
      projectId,
      id,
      content: { type: "doc", content: [] },
      searchText: "prose",
      wordCount: 1,
    });
    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "Second thought." });

    expect(queued().filter((entry) => entry.entity_type === "document")).toHaveLength(1);
    expect(payloadFor(id).synopsis).toBe("Second thought.");
    expect(payloadFor(id).search_text).toBe("prose");
  });
});
