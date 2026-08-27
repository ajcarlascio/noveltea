// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCollectionMembers, loadCollections, loadMembershipsOf } from "@/data/collections";
import { COMMANDS } from "@/db/commands";
import type { CollectionQuery } from "@/db/collection-commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * What a collection actually contains, against the real schema and the real FTS index.
 *
 * Smart collections are the reason this needs a database rather than a fake reader:
 * the whole feature is a query, and a stubbed reader would only prove the SQL string
 * was assembled, not that SQLite answers it — or that `document_fts` is populated by
 * its triggers, which is where an offline saved search actually lives or dies.
 */

let db: TestDatabase;
let projectId: string;
let povId: string;
let draftId: string;

const doc = (title: string, text: string) => {
  const id = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title,
  }).id;
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id,
    content: { type: "doc", content: [] },
    searchText: text,
    wordCount: text.split(/\s+/).length,
  });
  return id;
};

const folder = (title: string) =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title }).id;

const smart = (name: string, query: CollectionQuery) =>
  COMMANDS.createCollection(db.adapter, { projectId, name, color: null, query });

/** The names a collection holds right now, read back through the data layer. */
async function contents(collectionId: string): Promise<string[]> {
  const all = await loadCollections(db, projectId);
  const collection = all.find((row) => row.id === collectionId)!;
  const members = await loadCollectionMembers(db, projectId, collection);
  return members.map((member) => member.title).sort();
}

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Long Goodbye" }).id;
  povId = COMMANDS.createTaxonomy(db.adapter, {
    projectId,
    kind: "label",
    name: "Marlowe's POV",
    color: "#3d6b8e",
  }).id;
  draftId = COMMANDS.createTaxonomy(db.adapter, {
    projectId,
    kind: "status",
    name: "First draft",
    color: null,
  }).id;
});

afterEach(() => db.close());

describe("a saved list", () => {
  it("holds what was put on it, in the order it was put there", async () => {
    const one = doc("Chapter One", "the lighthouse kept its own hours");
    const two = doc("Chapter Two", "a car waited at the kerb");
    const saved = COMMANDS.createCollection(db.adapter, {
      projectId,
      name: "Act One",
      color: null,
      query: null,
    });

    COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: two,
    });
    COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: one,
    });

    const collection = (await loadCollections(db, projectId))[0]!;
    const members = await loadCollectionMembers(db, projectId, collection);
    // Membership order, not binder order: the list is a thing the author arranged.
    expect(members.map((member) => member.title)).toEqual(["Chapter Two", "Chapter One"]);
  });

  it("drops a member that has been trashed, and has it back when it is restored", async () => {
    const one = doc("Chapter One", "the lighthouse kept its own hours");
    const saved = COMMANDS.createCollection(db.adapter, {
      projectId,
      name: "Act One",
      color: null,
      query: null,
    });
    COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: one,
    });

    COMMANDS.trashBinderItem(db.adapter, { projectId, id: one });
    expect(await contents(saved.id)).toEqual([]);

    // The membership row was never touched — a collection is a way of looking at the
    // manuscript, and something in the trash is not in the manuscript yet.
    COMMANDS.restoreBinderItem(db.adapter, { projectId, id: one });
    expect(await contents(saved.id)).toEqual(["Chapter One"]);
  });

  it("reports which lists an item is already on", async () => {
    const one = doc("Chapter One", "the lighthouse");
    const first = COMMANDS.createCollection(db.adapter, {
      projectId,
      name: "Act One",
      color: null,
      query: null,
    });
    COMMANDS.createCollection(db.adapter, {
      projectId,
      name: "Act Two",
      color: null,
      query: null,
    });
    COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: first.id,
      binderItemId: one,
    });

    expect([...(await loadMembershipsOf(db, projectId, one))]).toEqual([first.id]);
  });
});

describe("a saved search", () => {
  it("finds every scene a name appears in, from the body text alone", async () => {
    doc("Chapter One", "Marlowe put the car in gear and drove north");
    doc("Chapter Two", "the house was empty and the phone rang twice");
    doc("Chapter Three", "Marlowe waited in the dark");

    const saved = smart("Marlowe", { text: "marlowe" });
    expect(await contents(saved.id)).toEqual(["Chapter One", "Chapter Three"]);
  });

  it("follows the manuscript: rewriting a scene changes what the search holds", async () => {
    const two = doc("Chapter Two", "the house was empty");
    const saved = smart("Marlowe", { text: "marlowe" });
    expect(await contents(saved.id)).toEqual([]);

    // No refresh, no rebuild, no membership row: a smart collection is answered at read
    // time, which is the only reason it can be right offline.
    COMMANDS.saveDocument(db.adapter, {
      projectId,
      id: two,
      content: { type: "doc", content: [] },
      searchText: "Marlowe came back for the envelope",
      wordCount: 6,
    });
    expect(await contents(saved.id)).toEqual(["Chapter Two"]);
  });

  it("combines conditions with AND, and values within one with OR", async () => {
    const one = doc("Chapter One", "Marlowe drove north");
    const two = doc("Chapter Two", "Marlowe waited");
    doc("Chapter Three", "Marlowe slept");
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: one, labelId: povId, statusId: draftId });
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: two, labelId: povId });

    // Label AND status: Chapter Two has the label but not the status.
    const both = smart("Drafted POV", { labelIds: [povId], statusIds: [draftId] });
    expect(await contents(both.id)).toEqual(["Chapter One"]);

    // Label alone: both wear it.
    const byLabel = smart("POV", { labelIds: [povId] });
    expect(await contents(byLabel.id)).toEqual(["Chapter One", "Chapter Two"]);
  });

  it("can be narrowed to one kind of item", async () => {
    doc("Chapter One", "the lighthouse");
    folder("Act One");

    const everything = smart("Everything", {});
    expect(await contents(everything.id)).toEqual(["Act One", "Chapter One"]);

    const documentsOnly = smart("Scenes", { types: ["document"] });
    expect(await contents(documentsOnly.id)).toEqual(["Chapter One"]);
  });

  it("matches a folder by its title, which is all a folder has", async () => {
    // Folders have no `document` row and so nothing in the index. Leaving them out of a
    // text search entirely would mean a search for "Marlowe" missing the folder called
    // "Marlowe's chapters", which is the obvious hit.
    folder("Marlowe's chapters");
    doc("Chapter One", "the house was empty");

    const saved = smart("Marlowe", { text: "marlowe" });
    expect(await contents(saved.id)).toEqual(["Marlowe's chapters"]);
  });

  it("excludes the trash, like every other view of the manuscript", async () => {
    const one = doc("Chapter One", "Marlowe drove north");
    const saved = smart("Marlowe", { text: "marlowe" });
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: one });
    expect(await contents(saved.id)).toEqual([]);
  });

  it("finds nothing when the text tokenises to nothing", async () => {
    doc("Chapter One", "Marlowe drove north");
    // `-marlowe` alone is "everything except this", which FTS5 cannot answer and which
    // must not fall through to "everything" — the collection would silently become the
    // whole manuscript.
    const saved = smart("Broken", { text: "-marlowe" });
    expect(await contents(saved.id)).toEqual([]);
  });

  it("with no conditions holds the whole manuscript, which is what it says", async () => {
    doc("Chapter One", "the lighthouse");
    doc("Chapter Two", "the kerb");
    const saved = smart("Everything", {});
    expect(await contents(saved.id)).toEqual(["Chapter One", "Chapter Two"]);
  });
});

it("EXCLUDES A SCENE INSIDE A TRASHED FOLDER, NOT JUST THE FOLDER", async () => {
  // Discarding an act reparents the *folder* to the trash node; its scenes still point
  // at the folder. Testing `parent_id = trash` therefore catches the folder and none of
  // the chapters in it, and a whole discarded act turns up in a saved search. The
  // recursive walk down from the trash node is what makes this hold.
  const act = folder("Act Three");
  const scene = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: act,
    type: "document",
    title: "The kerb",
  }).id;
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id: scene,
    content: { type: "doc", content: [] },
    searchText: "Marlowe drove north",
    wordCount: 3,
  });
  COMMANDS.trashBinderItem(db.adapter, { projectId, id: act });

  const search = smart("Marlowe", { text: "marlowe" });
  expect(await contents(search.id)).toEqual([]);

  // And the same for a hand-made list, which is a different query in the same function.
  const list = COMMANDS.createCollection(db.adapter, {
    projectId,
    name: "Act Three",
    color: null,
    query: null,
  });
  COMMANDS.addToCollection(db.adapter, {
    projectId,
    collectionId: list.id,
    binderItemId: scene,
  });
  expect(await contents(list.id)).toEqual([]);
});
