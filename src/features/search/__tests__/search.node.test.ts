// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { search, toFtsQuery } from "@/data/search";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
});

afterEach(() => db.close());

function writeDocument(title: string, body: string, extra: { synopsis?: string; notes?: string } = {}) {
  const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title });
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id: item.id,
    content: { type: "doc" },
    searchText: body,
    wordCount: body.split(/\s+/).length,
  });
  if (extra.synopsis !== undefined || extra.notes !== undefined) {
    db.adapter.run("UPDATE document SET synopsis = ?, notes = ? WHERE id = ?;", [
      extra.synopsis ?? null,
      extra.notes ?? null,
      item.id,
    ]);
  }
  return item;
}

const titles = async (input: string, options = {}) =>
  (await search(db.client, projectId, input, options)).map((hit) => hit.title);

describe("building a query from what someone typed", () => {
  it("treats bare words as terms that must all appear", () => {
    expect(toFtsQuery("lighthouse keeper")).toBe('"lighthouse" AND "keeper"');
  });

  it("keeps a quoted phrase together", () => {
    expect(toFtsQuery('"the lighthouse keeper"')).toBe('"the lighthouse keeper"');
  });

  it("reads a leading minus as an exclusion", () => {
    expect(toFtsQuery("lighthouse -keeper")).toBe('"lighthouse" NOT "keeper"');
  });

  it("finds nothing rather than everything for an empty search", () => {
    // Returning every document for an empty box would bury the author in their own
    // novel the moment they clicked into the field.
    for (const input of ["", "   ", '""', "-", "***"]) {
      expect(toFtsQuery(input), input).toBeNull();
    }
  });

  it("finds nothing for a search that is only exclusions", () => {
    // "everything except this" has no candidate set, and FTS5 will not answer it.
    expect(toFtsQuery("-keeper")).toBeNull();
    expect(toFtsQuery("-keeper -lamp")).toBeNull();
  });

  it("strips the characters FTS5 treats as syntax", () => {
    // Escaping would keep them and still change what the query means. An author
    // typing punctuation means the words around it.
    expect(toFtsQuery('light(house)')).toBe('"light" AND "house"');
    expect(toFtsQuery('lighthouse^2')).toBe('"lighthouse" AND "2"');
    expect(toFtsQuery('say "hello')).toBe('"say" AND "hello"');
  });
});

describe("searching", () => {
  it("finds a document by a word in its body", async () => {
    writeDocument("Chapter One", "the lighthouse kept its own hours");
    expect(await titles("lighthouse")).toEqual(["Chapter One"]);
  });

  it("finds a document by its title", async () => {
    writeDocument("The Lighthouse", "salt on the window");
    expect(await titles("lighthouse")).toEqual(["The Lighthouse"]);
  });

  it("finds a folder, which has a title worth finding", async () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Lighthouse notes" });
    expect(await titles("lighthouse")).toEqual(["Lighthouse notes"]);
  });

  it("searches synopses and notes, which are never exported", async () => {
    // Exactly what an author searches to find a scene again. Leaving them out would
    // make them write-only.
    writeDocument("Chapter One", "nothing relevant", { synopsis: "the keeper drowns" });
    writeDocument("Chapter Two", "nothing either", { notes: "check the tide tables" });

    expect(await titles("drowns")).toEqual(["Chapter One"]);
    expect(await titles("tide")).toEqual(["Chapter Two"]);
  });

  it("ranks a title above a passing mention", async () => {
    writeDocument("Storms", "the word lighthouse appears once here");
    writeDocument("The Lighthouse", "salt and wind and rain");

    // Someone typing "lighthouse" wants the scene called that, not the twentieth
    // paragraph mentioning one.
    const results = await search(db.client, projectId, "lighthouse");
    expect(results[0]?.title).toBe("The Lighthouse");
  });

  it("requires every bare word", async () => {
    writeDocument("Both", "the lighthouse keeper waited");
    writeDocument("One", "the lighthouse stood alone");
    expect(await titles("lighthouse keeper")).toEqual(["Both"]);
  });

  it("honours an exclusion", async () => {
    writeDocument("With", "the lighthouse keeper waited");
    writeDocument("Without", "the lighthouse stood alone");
    expect(await titles("lighthouse -keeper")).toEqual(["Without"]);
  });

  it("matches a phrase only where the words are adjacent", async () => {
    writeDocument("Adjacent", "the lighthouse keeper waited");
    writeDocument("Apart", "the lighthouse and then later the keeper");
    expect(await titles('"lighthouse keeper"')).toEqual(["Adjacent"]);
  });

  it("returns a snippet showing where the match was", async () => {
    writeDocument("Chapter One", "a long way before the lighthouse and a long way after");
    const [hit] = await search(db.client, projectId, "lighthouse");
    expect(hit?.snippet).toContain("lighthouse");
  });

  it("ignores accents, so an author need not reproduce them", async () => {
    writeDocument("Café", "they met at the café on the front");
    expect(await titles("cafe")).toContain("Café");
  });

  it("finds nothing for a word nobody wrote", async () => {
    writeDocument("Chapter One", "the lighthouse kept its own hours");
    expect(await titles("submarine")).toEqual([]);
  });
});

describe("what is excluded", () => {
  it("leaves trashed items out by default", async () => {
    const kept = writeDocument("Kept", "the lighthouse");
    const trashed = writeDocument("Discarded", "the lighthouse");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: trashed.id });

    expect(await titles("lighthouse")).toEqual(["Kept"]);
    expect(kept).toBeDefined();
  });

  it("returns them flagged when asked for", async () => {
    const trashed = writeDocument("Discarded", "the lighthouse");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: trashed.id });

    const results = await search(db.client, projectId, "lighthouse", { includeTrashed: true });
    expect(results.map((r) => r.title)).toEqual(["Discarded"]);
    // Flagged, so the interface can say where it came from rather than pretending it
    // is still in the binder.
    expect(results[0]?.trashed).toBe(true);
  });

  it("never returns a tombstoned item", async () => {
    const gone = writeDocument("Gone", "the lighthouse");
    db.adapter.run("UPDATE binder_item SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?;", [gone.id]);
    expect(await titles("lighthouse", { includeTrashed: true })).toEqual([]);
  });

  it("never returns another project's work", async () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Other" }).id;
    const theirs = COMMANDS.createBinderItem(db.adapter, {
      projectId: other, parentId: null, type: "document", title: "Theirs",
    });
    COMMANDS.saveDocument(db.adapter, {
      projectId: other, id: theirs.id, content: {}, searchText: "the lighthouse", wordCount: 2,
    });
    writeDocument("Mine", "the lighthouse");

    expect(await titles("lighthouse")).toEqual(["Mine"]);
  });
});

describe("staying current", () => {
  it("finds a document under its new title after a rename", async () => {
    const item = writeDocument("Old Title", "salt and wind");
    COMMANDS.renameBinderItem(db.adapter, { projectId, id: item.id, title: "Lighthouse" });

    // Without the rename trigger a document stays findable only under a title the
    // author has already changed.
    expect(await titles("lighthouse")).toEqual(["Lighthouse"]);
    expect(await titles("Old Title")).toEqual([]);
  });

  it("reflects an edit rather than the text that was there before", async () => {
    const item = writeDocument("Chapter One", "the lighthouse");
    COMMANDS.saveDocument(db.adapter, {
      projectId, id: item.id, content: {}, searchText: "the submarine", wordCount: 2,
    });

    expect(await titles("lighthouse")).toEqual([]);
    expect(await titles("submarine")).toEqual(["Chapter One"]);
  });
});

describe("hostile input", () => {
  it("answers rather than throwing, whatever is typed", async () => {
    // FTS5 raises a syntax error on malformed input, which would reach an author
    // mid-sentence as a crash.
    writeDocument("Chapter One", "the lighthouse kept its own hours");
    for (const input of ['"', '""""', "a AND", "OR OR", "NEAR(", "*", "^", "()", "a\\b", "'; DROP TABLE document;--"]) {
      await expect(search(db.client, projectId, input), input).resolves.toBeInstanceOf(Array);
    }
    // ...and the table is still there.
    expect(await titles("lighthouse")).toEqual(["Chapter One"]);
  });
});
