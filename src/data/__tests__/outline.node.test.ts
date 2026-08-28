// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { loadOutline, sortOutline, withFolderTotals, type OutlineRow } from "@/data/outline";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * The outliner's data, against the real schema.
 *
 * Two things here are worth a database rather than a stub: the recursive walk that puts
 * the binder in reading order, and the fact that it never sees the trash — not because
 * it filters it out, but because it starts at the top-level items and descends past it.
 */

let db: TestDatabase;
let projectId: string;

const reader = {
  query: <T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> =>
    Promise.resolve(db.adapter.query<T>(sql, params)),
};

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Long Goodbye" }).id;
});

afterEach(() => db.close());

const folder = (title: string, parentId: string | null = null) =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId, type: "folder", title }).id;

function document(title: string, words: number, parentId: string | null = null): string {
  const id = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId,
    type: "document",
    title,
  }).id;
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id,
    content: { type: "doc", content: [] },
    searchText: title,
    wordCount: words,
  });
  return id;
}

const row = (over: Partial<OutlineRow> = {}): OutlineRow => ({
  id: "x",
  type: "document",
  title: "A",
  depth: 0,
  synopsis: null,
  words: 0,
  labelId: null,
  statusId: null,
  ...over,
});

describe("reading the outline", () => {
  it("returns the binder in manuscript order, with each row's depth", async () => {
    const act = folder("Act One");
    document("The kerb", 600, act);
    document("The house", 400, act);
    document("An epilogue", 100);

    const rows = await loadOutline(reader, projectId);
    expect(rows.map((r) => [r.title, r.depth])).toEqual([
      ["Act One", 0],
      ["The kerb", 1],
      ["The house", 1],
      ["An epilogue", 0],
    ]);
  });

  it("PUTS A FOLDER'S CHILDREN BEFORE A SIBLING WHOSE KEY EXTENDS ITS OWN", async () => {
    // The case that decides the separator, and the only one that does. Ordinary appended
    // keys differ before the separator is ever reached; the deciding case is a sibling
    // inserted between two adjacent ones, whose key *extends* the earlier one's prefix.
    // That shape is real: `between("V", "W")` returns "VV". The literal keys below are
    // set directly — reaching them through moves takes a dozen inserts and would hide
    // what the test is about — and are picked to clear the trash node, which holds the
    // first generated key in every project.
    //
    // The child's path is then "zz<sep>…" compared against "zzV". '/' is 0x2F, below every
    // character an order key can hold (0-9A-Za-z), so the child sorts first. A separator
    // above them files every child after its parent's whole remaining level, and the
    // outline stops being the manuscript.
    const one = folder("Act One");
    const inserted = folder("Act Three");
    document("Inside one", 10, one);

    db.adapter.run("UPDATE binder_item SET order_key = 'zz' WHERE id = ?;", [one]);
    db.adapter.run("UPDATE binder_item SET order_key = 'zzV' WHERE id = ?;", [inserted]);

    const rows = await loadOutline(reader, projectId);
    expect(rows.map((r) => r.title)).toEqual(["Act One", "Inside one", "Act Three"]);
  });

  it("NEVER SHOWS A SCENE INSIDE A TRASHED FOLDER", async () => {
    // Not filtered out — unreachable. The walk starts at the top-level items, and a
    // trashed folder's parent is the trash node, which is not one of them.
    const act = folder("Act Three");
    document("Cut", 5_000, act);
    document("Kept", 1_000);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act });

    const rows = await loadOutline(reader, projectId);
    expect(rows.map((r) => r.title)).toEqual(["Kept"]);
  });

  it("gives a folder the words of everything beneath it", async () => {
    // A folder has no prose of its own, and zero is not the useful number when the
    // question is how long a chapter runs.
    const act = folder("Act One");
    const chapter = folder("Chapter One", act);
    document("The kerb", 600, chapter);
    document("The house", 400, act);

    const rows = await loadOutline(reader, projectId);
    const words = Object.fromEntries(rows.map((r) => [r.title, r.words]));
    expect(words).toEqual({
      "Act One": 1_000,
      "Chapter One": 600,
      "The kerb": 600,
      "The house": 400,
    });
  });

  it("carries the synopsis and the marks", async () => {
    const label = COMMANDS.createTaxonomy(db.adapter, {
      projectId,
      kind: "label",
      name: "Marlowe's POV",
      color: "#3d6b8e",
    });
    const id = document("The kerb", 600);
    COMMANDS.saveSynopsis(db.adapter, { projectId, id, synopsis: "He drives north." });
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id, labelId: label.id });

    const [only] = await loadOutline(reader, projectId);
    expect(only?.synopsis).toBe("He drives north.");
    expect(only?.labelId).toBe(label.id);
  });

  it("is empty for a project with nothing in it", async () => {
    expect(await loadOutline(reader, projectId)).toEqual([]);
  });
});

describe("folder totals", () => {
  it("does not count a nested folder's subtotal twice", () => {
    const rows = withFolderTotals([
      row({ id: "act", type: "folder", title: "Act", depth: 0 }),
      row({ id: "ch", type: "folder", title: "Chapter", depth: 1 }),
      row({ id: "a", title: "A", depth: 2, words: 100 }),
      row({ id: "b", title: "B", depth: 1, words: 50 }),
    ]);
    expect(rows.map((r) => [r.title, r.words])).toEqual([
      ["Act", 150],
      ["Chapter", 100],
      ["A", 100],
      ["B", 50],
    ]);
  });

  it("gives the same answer when run over its own output", () => {
    // What the `type === "document"` guard is actually for. A folder's own word count is
    // always zero as it comes out of the query, so without the guard nothing changes on
    // the first pass — and a second pass would fold every folder's subtotal into its
    // parent. Guarding on the type is what makes the function safe to apply twice.
    const rows = [
      row({ id: "act", type: "folder", title: "Act", depth: 0 }),
      row({ id: "ch", type: "folder", title: "Chapter", depth: 1 }),
      row({ id: "a", title: "A", depth: 2, words: 100 }),
      row({ id: "b", title: "B", depth: 1, words: 50 }),
    ];
    const once = withFolderTotals(rows);
    expect(withFolderTotals(once)).toEqual(once);
  });

  it("gives an empty folder zero rather than the rows after it", () => {
    const rows = withFolderTotals([
      row({ id: "empty", type: "folder", title: "Empty", depth: 0 }),
      row({ id: "after", title: "After", depth: 0, words: 900 }),
    ]);
    expect(rows[0]?.words).toBe(0);
  });
});

describe("sorting", () => {
  // Deliberately reversed against the ids: sorting by "l1" then "l2" gives a different
  // answer from sorting by "Zoe" then "Alice", so the test can tell which one ran. With
  // the names in id order the fixture proved nothing.
  const name = (id: string | null) => (id === null ? "" : id === "l1" ? "Zoe" : "Alice");
  const rows = [
    row({ id: "1", title: "Zebra", words: 10, labelId: "l2" }),
    row({ id: "2", title: "apple", words: 300, labelId: "l1" }),
    row({ id: "3", title: "Mango", words: 100, labelId: null }),
  ];

  it("leaves manuscript order alone when nothing is chosen", () => {
    expect(sortOutline(rows, null, name).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("sorts titles without case deciding the order", () => {
    // "apple" before "Zebra": an author reading their own chapter list does not expect
    // capitalisation to sort the book.
    expect(sortOutline(rows, { column: "title", descending: false }, name).map((r) => r.title))
      .toEqual(["apple", "Mango", "Zebra"]);
  });

  it("sorts words as numbers, not as text", () => {
    expect(sortOutline(rows, { column: "words", descending: true }, name).map((r) => r.words))
      .toEqual([300, 100, 10]);
  });

  it("sorts a label by its name rather than by its id", () => {
    // The ids are uuids; sorting by them would produce an order with no meaning at all
    // and no way for the author to tell it was wrong.
    expect(sortOutline(rows, { column: "label", descending: false }, name).map((r) => r.id))
      .toEqual(["3", "1", "2"]);
  });

  it("does not modify the list it was given", () => {
    const before = rows.map((r) => r.id);
    sortOutline(rows, { column: "title", descending: true }, name);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});
