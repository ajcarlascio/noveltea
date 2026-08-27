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

    expect(COMMANDS.pruneMissing(db.adapter, { projectId, keepIds: [] })).toEqual({ removed: 1 });

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

    COMMANDS.pruneMissing(db.adapter, { projectId, keepIds: [kept.id] });
    expect(item(kept.id).deleted_at).toBeNull();
  });

  it("keeps an item with a pending change, which the server has never seen", () => {
    const mine = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Written offline",
    });

    COMMANDS.pruneMissing(db.adapter, { projectId, keepIds: [] });

    // The server could not have listed it. Its absence says nothing about whether the
    // author still wants it, and removing it would delete unsynced writing.
    expect(item(mine.id).deleted_at).toBeNull();
  });

  it("never removes the trash node", () => {
    // The server does not list it in the binder, and a project without one has
    // nowhere to trash things.
    COMMANDS.pruneMissing(db.adapter, { projectId, keepIds: [] });
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

    COMMANDS.pruneMissing(db.adapter, { projectId, keepIds: [] });
    expect(item(theirs.id).deleted_at).toBeNull();
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
