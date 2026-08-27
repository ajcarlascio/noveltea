// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { normaliseQuery } from "@/db/collection-commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;
let chapterId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  chapterId = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const list = (name: string) =>
  COMMANDS.createCollection(db.adapter, { projectId, name, color: null, query: null });

const smart = (name: string, query: Parameters<typeof COMMANDS.createCollection>[1]["query"]) =>
  COMMANDS.createCollection(db.adapter, { projectId, name, color: null, query });

const queuedFor = (entityType: string, entityId: string) =>
  db.adapter
    .query<PendingChange>("SELECT * FROM pending_change;")
    .find((row) => row.entity_type === entityType && row.entity_id === entityId);

const members = (collectionId: string) =>
  db.adapter.query<{ binder_item_id: string }>(
    "SELECT binder_item_id FROM collection_item WHERE collection_id = ? ORDER BY order_key;",
    [collectionId],
  );

describe("normalising a saved query", () => {
  it("drops empty conditions rather than storing them", () => {
    expect(normaliseQuery({ labelIds: [], statusIds: ["  "], text: "   " })).toEqual({});
  });

  it("drops a types list naming both kinds, which is the same as no condition", () => {
    expect(normaliseQuery({ types: ["folder", "document"] })).toEqual({});
    expect(normaliseQuery({ types: ["document"] })).toEqual({ types: ["document"] });
  });

  it("drops a key this build cannot evaluate", () => {
    // Round-tripped through a server that stores it opaquely, so a newer client's key
    // would otherwise be saved back unchanged and the collection would claim a
    // condition nothing here applies.
    const query = { text: "marlowe", somethingNewer: true } as Record<string, unknown>;
    expect(normaliseQuery(query)).toEqual({ text: "marlowe" });
  });
});

describe("creating a collection", () => {
  it("makes a hand-made list when there is no query, and a smart one when there is", () => {
    expect(list("Act One").is_smart).toBe(0);
    const saved = smart("Marlowe", { text: "marlowe" });
    expect(saved.is_smart).toBe(1);
    expect(JSON.parse(saved.query!)).toEqual({ text: "marlowe" });
  });

  it("refuses a blank name", () => {
    expect(() => list("   ")).toThrow(/needs a name/i);
  });

  it("sends the query as an object and is_smart as a boolean, which is what the spec takes", () => {
    const saved = smart("Marlowe", { text: "marlowe" });
    const payload = JSON.parse(queuedFor("collection", saved.id)!.payload!) as Record<
      string,
      unknown
    >;
    // The server's SyncEntitySpec declares query JSON_OBJECT and is_smart BOOLEAN, and
    // refuses anything else as invalid_request rather than coercing it. SQLite stores
    // the one as text and the other as 0/1, so both are converted on the way out.
    expect(payload.query).toEqual({ text: "marlowe" });
    expect(payload.is_smart).toBe(true);
    expect(payload.name).toBe("Marlowe");
    expect(typeof payload.order_key).toBe("string");
  });

  it("omits query entirely for a list, rather than sending a null", () => {
    const saved = list("Act One");
    const payload = JSON.parse(queuedFor("collection", saved.id)!.payload!) as Record<
      string,
      unknown
    >;
    // A JSON null would be stored as jsonb null, which is *present* — and present with
    // is_smart false is fine, but the same habit on a smart collection trips the
    // server's own collection_smart_has_query invariant.
    expect("query" in payload).toBe(false);
    expect(payload.is_smart).toBe(false);
  });
});

describe("changing a collection", () => {
  it("renames without disturbing the saved query", () => {
    const saved = smart("Marlowe", { text: "marlowe" });
    COMMANDS.updateCollection(db.adapter, { projectId, id: saved.id, name: "Marlowe scenes" });
    const row = COMMANDS.listCollections(db.adapter, { projectId })[0]!;
    expect(row.name).toBe("Marlowe scenes");
    expect(JSON.parse(row.query!)).toEqual({ text: "marlowe" });
  });

  it("refuses to give a hand-made list a query", () => {
    // Both directions are possible in the schema and both are traps: one discards the
    // query that *was* the collection, the other makes hand-picked members stop being
    // what it holds.
    const saved = list("Act One");
    expect(() =>
      COMMANDS.updateCollection(db.adapter, { projectId, id: saved.id, query: { text: "x" } }),
    ).toThrow(/a list, not a saved search/i);
  });
});

describe("membership", () => {
  it("adds an item once, and says so quietly the second time", () => {
    const saved = list("Act One");
    const first = COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: chapterId,
    });
    const again = COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: chapterId,
    });
    expect(again.id).toBe(first.id);
    expect(members(saved.id)).toHaveLength(1);
  });

  it("sends both parent ids, which the server requires on create", () => {
    const saved = list("Act One");
    const { id } = COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: chapterId,
    });
    const payload = JSON.parse(queuedFor("collection_item", id)!.payload!) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      collection_id: saved.id,
      binder_item_id: chapterId,
    });
    expect(typeof payload.order_key).toBe("string");
  });

  it("refuses to hand-add to a saved search, and to add an item from another project", () => {
    const saved = smart("Marlowe", { text: "marlowe" });
    expect(() =>
      COMMANDS.addToCollection(db.adapter, {
        projectId,
        collectionId: saved.id,
        binderItemId: chapterId,
      }),
    ).toThrow(/collects its own members/i);

    const other = COMMANDS.createProject(db.adapter, { title: "Another book" }).id;
    const theirs = COMMANDS.createBinderItem(db.adapter, {
      projectId: other,
      parentId: null,
      type: "document",
      title: "Their chapter",
    }).id;
    const mine = list("Act One");
    expect(() =>
      COMMANDS.addToCollection(db.adapter, {
        projectId,
        collectionId: mine.id,
        binderItemId: theirs,
      }),
    ).toThrow(/not in this project/i);
  });

  it("removes the row outright, because collection_item has no tombstone", () => {
    const saved = list("Act One");
    COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: chapterId,
    });
    db.adapter.run("DELETE FROM pending_change;");

    const outcome = COMMANDS.removeFromCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: chapterId,
    });

    expect(outcome.removed).toBe(1);
    expect(members(saved.id)).toEqual([]);
    // The queue entry is the only thing that tells another device, and the server hard
    // deletes for this type too — there is no deleted_at on either side.
    const queued = db.adapter.query<PendingChange>(
      "SELECT * FROM pending_change WHERE entity_type = 'collection_item';",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.op).toBe("delete");
  });

  it("removing something that was never on the list changes nothing", () => {
    const saved = list("Act One");
    expect(
      COMMANDS.removeFromCollection(db.adapter, {
        projectId,
        collectionId: saved.id,
        binderItemId: chapterId,
      }).removed,
    ).toBe(0);
  });
});

describe("deleting a collection", () => {
  it("tombstones it and leaves its membership rows alone", () => {
    const saved = list("Act One");
    COMMANDS.addToCollection(db.adapter, {
      projectId,
      collectionId: saved.id,
      binderItemId: chapterId,
    });

    // Cleared so the delete is tested as a delete of a row the server has seen. Left
    // in, `enqueueChange` collapses create-then-delete to nothing, which is correct and
    // is the *other* case — pinned below.
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.deleteCollection(db.adapter, { projectId, id: saved.id });

    expect(COMMANDS.listCollections(db.adapter, { projectId })).toEqual([]);
    // Unreachable, not deleted: a queue entry per member would push forty changes to
    // say one thing, and nothing will read those rows again.
    expect(members(saved.id)).toHaveLength(1);
    expect(queuedFor("collection", saved.id)!.op).toBe("delete");
  });

  it("pushes nothing at all for one made and unmade before any sync", () => {
    const saved = list("Act One");
    COMMANDS.deleteCollection(db.adapter, { projectId, id: saved.id });
    expect(queuedFor("collection", saved.id)).toBeUndefined();
  });

  it("refuses a collection that is already gone", () => {
    const saved = list("Act One");
    COMMANDS.deleteCollection(db.adapter, { projectId, id: saved.id });
    expect(() => COMMANDS.deleteCollection(db.adapter, { projectId, id: saved.id })).toThrow(
      /not in this project/i,
    );
  });
});
