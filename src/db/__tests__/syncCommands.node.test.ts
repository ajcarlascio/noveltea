// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const state = () => COMMANDS.syncState(db.adapter, { projectId });

const item = (id: string) =>
  db.adapter.query<{ id: string; deleted_at: string | null }>(
    "SELECT id, deleted_at FROM binder_item WHERE id = ?;",
    [id],
  )[0]!;
const queued = () => db.adapter.query<PendingChange>("SELECT * FROM pending_change ORDER BY id;");

const binderChange = (id: number, entityId: string, over: Record<string, unknown> = {}) => ({
  id,
  entityType: "binder_item",
  entityId,
  op: "update",
  data: {
    id: entityId,
    project_id: projectId,
    parent_id: null,
    type: "folder",
    title: "From the server",
    order_key: "m",
    version: 3,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  },
});

describe("applyPull", () => {
  it("moves a local sibling aside rather than failing the page", () => {
    // Two devices, both offline, both add a sibling after the same item: `between` is
    // deterministic, so both choose the same key. Whichever pushes first wins, and
    // this device pulls a row whose key its own unpushed row already holds.
    const mine = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Mine",
    });
    const key = db.adapter.query<{ order_key: string }>(
      "SELECT order_key FROM binder_item WHERE id = ?;",
      [mine.id],
    )[0]!.order_key;

    expect(() =>
      COMMANDS.applyPull(db.adapter, {
        projectId,
        changes: [binderChange(7, "theirs", { order_key: key, title: "Theirs" })],
        latestId: 7,
        syncEpoch: 1,
      }),
    ).not.toThrow();

    // The server's ordering is the accepted one, so the local row moved.
    const rows = db.adapter.query<{ id: string; order_key: string }>(
      "SELECT id, order_key FROM binder_item WHERE project_id = ? AND parent_id IS NULL;",
      [projectId],
    );
    const theirs = rows.find((r) => r.id === "theirs")!;
    const moved = rows.find((r) => r.id === mine.id)!;
    expect(theirs.order_key).toBe(key);
    expect(moved.order_key).not.toBe(key);

    // ...and the server is told, or the two would disagree about order forever.
    const queuedMove = queued().find((row) => row.entity_id === mine.id);
    expect(queuedMove).toBeDefined();
    expect(JSON.parse(queuedMove!.payload!)).toMatchObject({ order_key: moved.order_key });
  });

  it("re-queues a displaced never-acknowledged item as a create, not an update", () => {
    // The C1 loss chain: a local create push lost the order_key race and was rejected
    // INVALID_REQUEST, so the client cleared its pending row. The item now exists only
    // here, version still 1, no pending change. A pull then displaces it off the key.
    // If the re-queue were an update the server would answer ENTITY_MISSING, the client
    // would clear it, and the item would vanish on the next resync. It must come back
    // as a create so the server accepts it.
    const mine = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Mine",
    });
    const key = db.adapter.query<{ order_key: string }>(
      "SELECT order_key FROM binder_item WHERE id = ?;",
      [mine.id],
    )[0]!.order_key;

    // Simulate the rejected-and-cleared create push.
    db.adapter.run("DELETE FROM pending_change WHERE entity_id = ?;", [mine.id]);

    COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [binderChange(7, "theirs", { order_key: key, title: "Theirs" })],
      latestId: 7,
      syncEpoch: 1,
    });

    const requeued = queued().find((row) => row.entity_id === mine.id);
    expect(requeued).toBeDefined();
    expect(requeued!.op).toBe("create");
    expect(requeued!.base_version).toBeNull();
    expect(JSON.parse(requeued!.payload!)).toMatchObject({
      id: mine.id,
      type: "folder",
      title: "Mine",
    });
  });

  it("inserts a row the client has never seen", () => {
    const result = COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [binderChange(7, "b1")],
      latestId: 7,
      syncEpoch: 1,
    });

    expect(result.applied).toBe(1);
    expect(
      db.adapter.query("SELECT title, version FROM binder_item WHERE id = 'b1';"),
    ).toEqual([{ title: "From the server", version: 3 }]);
  });

  it("updates a row the client already has", () => {
    COMMANDS.applyPull(db.adapter, { projectId, changes: [binderChange(7, "b1")], latestId: 7, syncEpoch: 1 });
    COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [binderChange(8, "b1", { title: "Renamed elsewhere", version: 4 })],
      latestId: 8,
      syncEpoch: 1,
    });

    expect(db.adapter.query("SELECT title, version FROM binder_item WHERE id = 'b1';")).toEqual([
      { title: "Renamed elsewhere", version: 4 },
    ]);
  });

  it("applies a server change even when the entity has a pending local change", () => {
    // Skipping the row instead looks protective and is not: applyPull advances the cursor
    // in the same call, so a row it declines to apply is never offered again and this
    // replica drifts from the server in silence. Nothing is at risk here — the queued
    // payload still carries the local wording, and the server answers a stale base with a
    // conflict copy. The replica follows the server; the queue speaks for the author.
    const local = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Local title",
    });
    const before = queued().find((row) => row.entity_id === local.id)!;

    COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [binderChange(7, local.id, { title: "Remote title" })],
      latestId: 7,
      syncEpoch: 1,
    });

    expect(db.adapter.query("SELECT title FROM binder_item WHERE id = ?;", [local.id])).toEqual([
      { title: "Remote title" },
    ]);

    // The queue is what protects the author's version, so it must survive untouched —
    // payload and base_version both. A pull that quietly rewrote either would make the
    // next push look conflict-free and clobber the other device.
    const after = queued().find((row) => row.entity_id === local.id)!;
    expect(after.payload).toBe(before.payload);
    expect(after.base_version).toBe(before.base_version);
    expect(after.op).toBe(before.op);
  });

  it("applies a server delete even when the entity has a pending local change", () => {
    // The delete case is the one that cannot heal. An update is repeated by the next edit
    // to that entity; a delete is terminal, so a delete skipped here leaves the row live
    // on this device forever while every other device shows it gone. The words still
    // survive: the pending push reaches a server that no longer has the item, and it is
    // preserved as a live orphan copy.
    const local = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Chapter 3",
    });

    const result = COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [{ id: 42, entityType: "binder_item", entityId: local.id, op: "delete", data: {} }],
      latestId: 42,
      syncEpoch: 1,
    });

    expect(item(local.id).deleted_at).not.toBeNull();
    expect(result.applied).toBe(1);
    // Applied and counted, so the cursor advancing past it is honest.
    expect(state().lastChangeId).toBe(42);
  });

  it("advances the cursor and the epoch together with the rows", () => {
    // A cursor that moves without its rows skips them permanently; rows applied
    // without the cursor moving arrive twice.
    COMMANDS.applyPull(db.adapter, { projectId, changes: [binderChange(9, "b1")], latestId: 9, syncEpoch: 4 });
    expect(state()).toMatchObject({ lastChangeId: 9, syncEpoch: 4 });
    expect(state().lastSyncedAt).not.toBeNull();
  });

  it("tombstones on a delete rather than removing the row", () => {
    COMMANDS.applyPull(db.adapter, { projectId, changes: [binderChange(7, "b1")], latestId: 7, syncEpoch: 1 });
    COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [{ id: 8, entityType: "binder_item", entityId: "b1", op: "delete", data: null }],
      latestId: 8,
      syncEpoch: 1,
    });

    // The row is what tells a later reader the item is gone.
    const rows = db.adapter.query<{ deleted_at: string | null }>(
      "SELECT deleted_at FROM binder_item WHERE id = 'b1';",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it("ignores a field this client's schema does not have", () => {
    // A newer server sends more than an older client knows. Failing the page over it
    // would stall sync on a version difference.
    const change = binderChange(7, "b1");
    (change.data as Record<string, unknown>).sentiment_score = 0.4;
    expect(() =>
      COMMANDS.applyPull(db.adapter, { projectId, changes: [change], latestId: 7, syncEpoch: 1 }),
    ).not.toThrow();
    expect(db.adapter.query("SELECT id FROM binder_item WHERE id = 'b1';")).toHaveLength(1);
  });

  it("skips an entity type it has no table for, and says which", () => {
    const result = COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [
        { id: 7, entityType: "mood_board", entityId: "x", op: "update", data: { id: "x" } },
        binderChange(8, "b1"),
      ],
      latestId: 8,
      syncEpoch: 1,
    });

    expect(result.skipped).toEqual(["mood_board"]);
    // The rest of the page still applies, and the cursor still advances.
    expect(result.applied).toBe(1);
    expect(state().lastChangeId).toBe(8);
  });

  it("stores nested JSON as text, because SQLite has no JSON type", () => {
    COMMANDS.applyPull(db.adapter, { projectId, changes: [binderChange(7, "d1", { type: "document" })], latestId: 7, syncEpoch: 1 });
    COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [
        {
          id: 8,
          entityType: "document",
          entityId: "d1",
          op: "update",
          data: {
            id: "d1",
            content: { type: "doc", content: [{ type: "paragraph" }] },
            word_count: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      ],
      latestId: 8,
      syncEpoch: 1,
    });

    const row = db.adapter.query<{ content: string }>("SELECT content FROM document WHERE id = 'd1';")[0]!;
    expect(JSON.parse(row.content)).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("clears a previous error once a pull succeeds", () => {
    COMMANDS.recordSyncFailure(db.adapter, { projectId, error: "offline" });
    expect(state().lastError).toBe("offline");

    COMMANDS.applyPull(db.adapter, { projectId, changes: [], latestId: 3, syncEpoch: 1 });
    expect(state().lastError).toBeNull();
  });
});

describe("takePending", () => {
  it("marks rows in flight before handing them over", () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });

    const taken = COMMANDS.takePending(db.adapter, { projectId });
    expect(taken).toHaveLength(1);

    // Before the push, never after: if a push is applied and the response is lost, an
    // unmarked entry can be dropped locally while the server keeps the row, and the
    // item returns on the next pull as a ghost.
    expect(queued()[0]!.attempts).toBe(1);
  });

  it("parses the payload back into an object", () => {
    const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    const [taken] = COMMANDS.takePending(db.adapter, { projectId });
    expect(taken).toMatchObject({ entityType: "binder_item", entityId: item.id, op: "create" });
    expect(taken!.data).toMatchObject({ title: "Act I" });
  });

  it("returns nothing when there is nothing queued", () => {
    expect(COMMANDS.takePending(db.adapter, { projectId })).toEqual([]);
  });
});

describe("settlePush", () => {
  it("clears only what the server accepted", () => {
    const a = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "A" });
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "B" });

    const taken = COMMANDS.takePending(db.adapter, { projectId });
    const acceptedId = taken.find((row) => row.entityId === a.id)!.id;
    COMMANDS.settlePush(db.adapter, { ids: [acceptedId] });

    // The other stays queued for the next push rather than being lost.
    expect(queued()).toHaveLength(1);
    expect(queued()[0]!.entity_id).not.toBe(a.id);
  });
});

describe("resetForResync", () => {
  it("clears the project's replica and the cursor", () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    COMMANDS.applyPull(db.adapter, { projectId, changes: [], latestId: 40, syncEpoch: 2 });

    COMMANDS.resetForResync(db.adapter, { projectId });

    expect(db.adapter.query("SELECT id FROM binder_item WHERE project_id = ?;", [projectId])).toEqual([]);
    expect(state().lastChangeId).toBe(0);
  });

  it("keeps the pending queue, which the server has never seen", () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    const before = queued().length;

    COMMANDS.resetForResync(db.adapter, { projectId });

    // Those are local edits that never left the device. Discarding them would lose
    // writing outright, which is the one thing a resync must not do.
    expect(queued()).toHaveLength(before);
  });
});

describe("recordSyncFailure", () => {
  it("records the reason without moving the cursor", () => {
    COMMANDS.applyPull(db.adapter, { projectId, changes: [], latestId: 12, syncEpoch: 1 });
    COMMANDS.recordSyncFailure(db.adapter, { projectId, error: "Could not reach the server." });

    const after = state();
    expect(after.lastError).toBe("Could not reach the server.");
    // A failed attempt must not look like progress.
    expect(after.lastChangeId).toBe(12);
  });
});

describe("syncState", () => {
  it("reports zero for a project that has never synced", () => {
    expect(state()).toMatchObject({ lastChangeId: 0, syncEpoch: 1, lastSyncedAt: null, pending: 0 });
  });

  it("counts what is waiting to go out", () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    expect(state().pending).toBe(1);
  });
});

describe("pruneMissing", () => {
  it("tombstones an item the server did not list", () => {
    const ghost = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Deleted while away",
    });
    db.adapter.run("DELETE FROM pending_change;");

    expect(COMMANDS.pruneMissing(db.adapter, { projectId, keep: { binder_item: [] } })).toEqual({ removed: 1 });

    // Its delete row was purged by retention, so absence is the only thing left
    // saying it is gone. Keeping it would leave a ghost the author cannot remove.
    const row = db.adapter.query<{ deleted_at: string | null }>(
      "SELECT deleted_at FROM binder_item WHERE id = ?;", [ghost.id],
    )[0]!;
    expect(row.deleted_at).not.toBeNull();
  });

  it("keeps an item the server did list", () => {
    const kept = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Still there",
    });
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { binder_item: [kept.id] } });
    expect(item(kept.id).deleted_at).toBeNull();
  });

  it("keeps an item with a pending change, which the server has never seen", () => {
    const mine = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Written offline",
    });

    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { binder_item: [] } });

    // The server could not have listed it. Its absence says nothing about whether the
    // author still wants it, and removing it would delete unsynced writing.
    expect(item(mine.id).deleted_at).toBeNull();
  });

  it("never removes the trash node", () => {
    // A project without one has nowhere to trash things, whatever a listing says.
    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { binder_item: [] } });
    expect(
      db.adapter.query("SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';", [projectId]),
    ).toHaveLength(1);
  });

  it("leaves another project alone", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Other" }).id;
    const theirs = COMMANDS.createBinderItem(db.adapter, {
      projectId: other, parentId: null, type: "folder", title: "Theirs",
    });
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { binder_item: [] } });
    expect(item(theirs.id).deleted_at).toBeNull();
  });
});

describe("pruneMissing beyond the binder", () => {
  const labels = () =>
    db.adapter.query<{ name: string }>("SELECT name FROM taxonomy WHERE deleted_at IS NULL ORDER BY name;").map((r) => r.name);

  it("touches only the types it was given", () => {
    COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Draft", color: null });
    db.adapter.run("DELETE FROM pending_change;");

    // A server that cannot list labels says nothing about them by leaving them out.
    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { binder_item: [] } });
    expect(labels()).toEqual(["Draft"]);

    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { taxonomy: [] } });
    expect(labels()).toEqual([]);
  });

  it("deletes where the table has no tombstone, and leaves another project alone", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Other" }).id;
    COMMANDS.createTaxonomy(db.adapter, { projectId: other, kind: "label", name: "Theirs", color: null });
    const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    const collection = COMMANDS.createCollection(db.adapter, { projectId, name: "Mine", color: null, query: null });
    COMMANDS.addToCollection(db.adapter, { projectId, collectionId: collection.id, binderItemId: item.id });
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.pruneMissing(db.adapter, { projectId, keep: { taxonomy: [], collection_item: [] } });

    expect(labels()).toEqual(["Theirs"]);
    expect(db.adapter.query("SELECT id FROM collection_item;")).toEqual([]);
  });
});

describe("applyPull without a cursor", () => {
  it("applies rows but leaves the position alone", () => {
    COMMANDS.applyPull(db.adapter, { projectId, changes: [], latestId: 42, syncEpoch: 3 });

    COMMANDS.applyPull(db.adapter, {
      projectId,
      changes: [binderChange(1, "b1")],
      latestId: 0,
      syncEpoch: 0,
      advanceCursor: false,
    });

    // A rebuild applies rows that never came from the feed. Claiming position zero
    // would ask the server for another rebuild on the very next sync.
    expect(state()).toMatchObject({ lastChangeId: 42, syncEpoch: 3 });
    expect(db.adapter.query("SELECT id FROM binder_item WHERE id = 'b1';")).toHaveLength(1);
  });
});

/** Server-shaped rows for every type, as a pull or a rebuild would apply them. */
const stamp = "2026-03-01T00:00:00Z";
const serverRow = (entityType: string, id: string, data: Record<string, unknown>) => ({
  id: 0,
  entityType,
  entityId: id,
  op: "update",
  data: { id, version: 1, created_at: stamp, updated_at: stamp, ...data },
});
const pull = (...changes: ReturnType<typeof serverRow>[]) =>
  COMMANDS.applyPull(db.adapter, { projectId, changes, latestId: 0, syncEpoch: 0, advanceCursor: false });
const chapterRows = () => [
  serverRow("binder_item", "d1", { project_id: projectId, parent_id: null, type: "document", title: "Chapter One", order_key: "m" }),
  serverRow("document", "d1", { content: { type: "doc" } }),
];

describe("pruneMissing keeps every type's unsynced rows", () => {
  const ROWS: Record<string, () => ReturnType<typeof serverRow>> = {
    taxonomy: () => serverRow("taxonomy", "t1", { project_id: projectId, kind: "label", name: "Draft", color: null, order_key: "m", deleted_at: null }),
    custom_metadata_field: () => serverRow("custom_metadata_field", "f1", { project_id: projectId, name: "POV", field_type: "text", options: null, order_key: "m", deleted_at: null }),
    collection: () => serverRow("collection", "k1", { project_id: projectId, name: "Act I", query: null, is_smart: false, color: null, order_key: "m", deleted_at: null }),
    compile_preset: () => serverRow("compile_preset", "p1", { project_id: projectId, name: "Manuscript", format: "md", included_binder_items: ["d1"], include_query: null, separator_rules: {}, deleted_at: null }),
    comment: () => serverRow("comment", "c1", { project_id: projectId, document_id: "d1", parent_comment_id: null, body: "Tighten this", anchor: null, deleted_at: null }),
    custom_metadata_value: () => serverRow("custom_metadata_value", "v1", { binder_item_id: "d1", field_id: "f1", value: "Ann" }),
    collection_item: () => serverRow("collection_item", "i1", { collection_id: "k1", binder_item_id: "d1", order_key: "m" }),
    snapshot: () => serverRow("snapshot", "n1", { project_id: projectId, document_id: "d1", word_count: 0, label: null, is_automatic: false }),
  };
  const present = (type: string, id: string) =>
    db.adapter.query(`SELECT 1 FROM ${type} WHERE id = ?${type === "custom_metadata_value" || type === "collection_item" || type === "snapshot" ? "" : " AND deleted_at IS NULL"};`, [id]).length > 0;

  for (const [type, make] of Object.entries(ROWS)) {
    it(`keeps a ${type} with a pending change, and only that one`, () => {
      pull(...chapterRows(), ROWS.custom_metadata_field!(), ROWS.collection!(), make());
      const row = make();
      db.adapter.run(
        `INSERT INTO pending_change (project_id, entity_type, entity_id, op, payload, created_at, updated_at)
         VALUES (?, ?, ?, 'update', '{}', ?, ?);`,
        [projectId, type, row.entityId, stamp, stamp],
      );

      COMMANDS.pruneMissing(db.adapter, { projectId, keep: { [type]: [] } });
      expect(present(type, row.entityId)).toBe(true);

      // The same row without the pending change goes, or the line above proves nothing.
      db.adapter.run("DELETE FROM pending_change;");
      COMMANDS.pruneMissing(db.adapter, { projectId, keep: { [type]: [] } });
      expect(present(type, row.entityId)).toBe(false);
    });
  }

  describe("a manual snapshot whose content only this device holds", () => {
    // Pulled snapshots never carry content, so one that does was taken here. Deleting it
    // would destroy a draft that may be the only copy.
    const taken = () => {
      pull(...chapterRows());
      const snapshot = COMMANDS.captureSnapshot(db.adapter, { projectId, documentId: "d1", label: "Before the cut", automatic: false });
      db.adapter.run("DELETE FROM pending_change;");
      return snapshot;
    };
    const held = (id: string) =>
      db.adapter.query("SELECT content IS NOT NULL AS held FROM snapshot WHERE id = ?;", [id]);

    it("is queued again when the server lost it", () => {
      const snapshot = taken();

      COMMANDS.pruneMissing(db.adapter, { projectId, keep: { snapshot: [] }, requeueSnapshots: true });

      expect(held(snapshot.id)).toEqual([{ held: 1 }]);
      const [entry] = queued();
      expect(entry).toMatchObject({ entity_type: "snapshot", entity_id: snapshot.id, op: "create" });
      expect(JSON.parse(entry?.payload ?? "{}")).toMatchObject({ document_id: "d1", label: "Before the cut", content: { type: "doc" } });
    });

    it("is kept but not queued when the server may only have been told to delete it", () => {
      const snapshot = taken();

      COMMANDS.pruneMissing(db.adapter, { projectId, keep: { snapshot: [] } });

      expect(held(snapshot.id)).toEqual([{ held: 1 }]);
      expect(queued()).toHaveLength(0);
      // Unsynced is a state it tolerates: the author can still delete it, and the server
      // accepts the delete of a snapshot it has not got.
      COMMANDS.deleteSnapshot(db.adapter, { projectId, id: snapshot.id });
      expect(held(snapshot.id)).toEqual([]);
    });

    it("is not queued when its document is tombstoned here", () => {
      const snapshot = taken();
      db.adapter.run("UPDATE binder_item SET deleted_at = ? WHERE id = 'd1';", [stamp]);

      COMMANDS.pruneMissing(db.adapter, { projectId, keep: { snapshot: [] }, requeueSnapshots: true });

      expect(queued()).toHaveLength(0);
      expect(held(snapshot.id)).toEqual([]);
    });
  });
});

describe("applyPull and an unpushed document", () => {
  it("keeps the local body of a document with a pending change", () => {
    pull(...chapterRows());
    COMMANDS.saveDocument(db.adapter, { projectId, id: "d1", content: { type: "doc", content: [] }, searchText: "mine", wordCount: 1 });
    const before = queued()[0];

    pull(serverRow("document", "d1", { content: { type: "doc", attrs: { from: "elsewhere" } }, search_text: "theirs", version: 5 }));

    // The push that follows is what reconciles them; see the engine's conflict tests.
    expect(db.adapter.query("SELECT search_text, version FROM document WHERE id = 'd1';")).toEqual([{ search_text: "mine", version: 1 }]);
    expect(queued()[0]).toEqual(before);

    db.adapter.run("DELETE FROM pending_change;");
    pull(serverRow("document", "d1", { content: { type: "doc" }, search_text: "theirs", version: 5 }));
    expect(db.adapter.query("SELECT search_text FROM document WHERE id = 'd1';")).toEqual([{ search_text: "theirs" }]);
  });
});

describe("applyPull and a local row holding the server's natural key", () => {
  const live = (table: string) =>
    db.adapter.query<{ id: string }>(`SELECT id FROM ${table} WHERE deleted_at IS NULL ORDER BY id;`).map((r) => r.id);
  const SERVER_LABEL = "aaaaaaaa-0000-4000-8000-000000000001";
  const serverLabel = (name = "Draft") =>
    serverRow("taxonomy", SERVER_LABEL, { project_id: projectId, kind: "label", name, color: "#0033cc", order_key: "m", deleted_at: null });

  it("adopts the server's label for one made here too, and points everything at it", () => {
    pull(...chapterRows());
    const mine = COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Draft", color: null });
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: "d1", labelId: mine.id });
    const smart = COMMANDS.createCollection(db.adapter, { projectId, name: "Drafts", color: null, query: { labelIds: [mine.id] } });

    pull(serverLabel());

    expect(live("taxonomy")).toEqual([SERVER_LABEL]);
    expect(db.adapter.query("SELECT label_id FROM binder_item WHERE id = 'd1';")).toEqual([{ label_id: SERVER_LABEL }]);
    expect(db.adapter.query<{ query: string }>("SELECT query FROM collection WHERE id = ?;", [smart.id])[0]?.query).toContain(SERVER_LABEL);
    // The redundant create is gone; every queued payload that named it names the server's.
    expect(queued().map((q) => q.entity_type).sort()).toEqual(["binder_item", "collection"]);
    for (const entry of queued()) expect(entry.payload).not.toContain(mine.id);
    expect(JSON.parse(queued().find((q) => q.entity_type === "binder_item")?.payload ?? "{}")).toMatchObject({ label_id: SERVER_LABEL });
  });

  it("sets aside a label the server knows and this device renamed onto the same name", () => {
    pull(serverRow("taxonomy", "known", { project_id: projectId, kind: "label", name: "Old", color: null, order_key: "a", deleted_at: null }));
    COMMANDS.updateTaxonomy(db.adapter, { projectId, id: "known", name: "Draft", color: null });

    pull(serverLabel());

    expect(db.adapter.query("SELECT id, name FROM taxonomy ORDER BY id;")).toEqual([
      { id: SERVER_LABEL, name: "Draft" },
      { id: "known", name: "Draft (2)" },
    ]);
    expect(JSON.parse(queued()[0]?.payload ?? "{}")).toMatchObject({ name: "Draft (2)" });
  });

  it("tombstones a stale label with nothing pending, keeping what points at it valid", () => {
    pull(serverRow("taxonomy", "stale", { project_id: projectId, kind: "label", name: "Draft", color: null, order_key: "a", deleted_at: null }));
    pull(serverLabel());
    expect(live("taxonomy")).toEqual([SERVER_LABEL]);
    expect(db.adapter.query("SELECT id FROM taxonomy WHERE id = 'stale';")).toHaveLength(1);
  });

  it("adopts the server's field, moving this device's values onto it", () => {
    const SERVER_FIELD = "bbbbbbbb-0000-4000-8000-000000000001";
    pull(...chapterRows());
    const mine = COMMANDS.createMetadataField(db.adapter, { projectId, name: "POV", fieldType: "text" });
    COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId: "d1", fieldId: mine.id, value: "Ann" });

    pull(serverRow("custom_metadata_field", SERVER_FIELD, { project_id: projectId, name: "POV", field_type: "text", options: null, order_key: "m", deleted_at: null }));

    expect(live("custom_metadata_field")).toEqual([SERVER_FIELD]);
    expect(db.adapter.query("SELECT field_id, value FROM custom_metadata_value;")).toEqual([{ field_id: SERVER_FIELD, value: '"Ann"' }]);
    expect(queued().map((q) => q.entity_type)).toEqual(["custom_metadata_value"]);
    expect(JSON.parse(queued()[0]?.payload ?? "{}")).toMatchObject({ field_id: SERVER_FIELD, value: "Ann" });
  });

  it("keeps this device's value for an item and field the server has a value for", () => {
    pull(...chapterRows(), serverRow("custom_metadata_field", "f1", { project_id: projectId, name: "POV", field_type: "text", options: null, order_key: "m", deleted_at: null }));
    COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId: "d1", fieldId: "f1", value: "Ann" });

    pull(serverRow("custom_metadata_value", "server-value", { binder_item_id: "d1", field_id: "f1", value: "Bea" }));

    // Last write wins on push, so the unsynced value is the one the server will hold.
    expect(db.adapter.query("SELECT id, value FROM custom_metadata_value;")).toEqual([{ id: "server-value", value: '"Ann"' }]);
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ entity_id: "server-value", op: "update" });
  });

  it("drops a collection membership made here that the server already has", () => {
    pull(...chapterRows(), serverRow("collection", "k1", { project_id: projectId, name: "Act I", query: null, is_smart: false, color: null, order_key: "m", deleted_at: null }));
    COMMANDS.addToCollection(db.adapter, { projectId, collectionId: "k1", binderItemId: "d1" });

    pull(serverRow("collection_item", "server-member", { collection_id: "k1", binder_item_id: "d1", order_key: "m" }));

    expect(db.adapter.query("SELECT id FROM collection_item;")).toEqual([{ id: "server-member" }]);
    expect(queued()).toHaveLength(0);
  });
});

describe("queued tags", () => {
  it("carries a label set earlier through a later rename", () => {
    pull(...chapterRows(), serverRow("taxonomy", "t1", { project_id: projectId, kind: "label", name: "Draft", color: null, order_key: "m", deleted_at: null }));
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: "d1", labelId: "t1" });
    COMMANDS.renameBinderItem(db.adapter, { projectId, id: "d1", title: "Renamed" });

    const payload = JSON.parse(queued()[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({ title: "Renamed", label_id: "t1" });
    // Only the tag the author touched.
    expect(payload).not.toHaveProperty("status_id");
  });
});

describe("settlePush", () => {
  it("moves an accepted row's version to the server's", () => {
    pull(...chapterRows());
    COMMANDS.saveDocument(db.adapter, { projectId, id: "d1", content: { type: "doc" }, searchText: "x", wordCount: 1 });
    const [taken] = COMMANDS.takePending(db.adapter, { projectId });

    COMMANDS.settlePush(db.adapter, {
      ids: [taken!.id],
      sent: [{ id: taken!.id, payload: taken!.payload }],
      applied: [{ entityType: "document", entityId: "d1", version: 2 }],
    });

    expect(queued()).toHaveLength(0);
    expect(db.adapter.query("SELECT version FROM document WHERE id = 'd1';")).toEqual([{ version: 2 }]);
  });
});
