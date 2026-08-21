// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, type BinderItemRow } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * Commands are synchronous functions over a SqliteAdapter, so they run here against
 * real SQLite with the real migrations — the same code the worker executes, with
 * nothing stubbed.
 */

let db: TestDatabase;
let projectId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
});

afterEach(() => db.close());

const create = (title: string, parentId: string | null = null, type: "folder" | "document" = "folder") =>
  COMMANDS.createBinderItem(db.adapter, { projectId, parentId, type, title });

const item = (id: string) =>
  db.adapter.query<BinderItemRow>("SELECT * FROM binder_item WHERE id = ?;", [id])[0]!;

const queued = () =>
  db.adapter.query<PendingChange>("SELECT * FROM pending_change ORDER BY id;");

const trashId = () =>
  db.adapter.query<{ id: string }>(
    "SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';",
    [projectId],
  )[0]!.id;

const childrenOf = (parentId: string | null) =>
  db.adapter
    .query<BinderItemRow>(
      `SELECT * FROM binder_item
        WHERE project_id = ? AND parent_id IS ${parentId === null ? "NULL" : "?"}
          AND deleted_at IS NULL AND type <> 'trash'
        ORDER BY order_key;`,
      parentId === null ? [projectId] : [projectId, parentId],
    )
    .map((row) => row.title);

describe("createProject", () => {
  it("gives the project exactly one trash node", () => {
    const trash = db.adapter.query("SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';", [projectId]);
    expect(trash).toHaveLength(1);
  });

  it("refuses a blank title", () => {
    expect(() => COMMANDS.createProject(db.adapter, { title: "   " })).toThrow(/title/i);
  });
});

describe("createBinderItem", () => {
  it("appends to the end of the sibling list", () => {
    create("Act I");
    create("Act II");
    create("Act III");
    expect(childrenOf(null)).toEqual(["Act I", "Act II", "Act III"]);
  });

  it("gives a document its document row", () => {
    const doc = create("Chapter One", null, "document");
    expect(db.adapter.query("SELECT id FROM document WHERE id = ?;", [doc.id])).toHaveLength(1);
  });

  it("queues a create for the server", () => {
    const folder = create("Act I");
    const rows = queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "binder_item", entity_id: folder.id, op: "create" });
    expect(JSON.parse(rows[0]!.payload!)).toMatchObject({ title: "Act I", type: "folder" });
  });

  it("refuses to nest anything inside a document", () => {
    const doc = create("Chapter One", null, "document");
    // The schema permits it; the semantics do not. A document is a leaf.
    expect(() => create("Stray", doc.id)).toThrow(/cannot contain/i);
  });

  it("refuses a blank title", () => {
    expect(() => create("   ")).toThrow(/title/i);
  });

  it("refuses a parent from another project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Other" }).id;
    const foreign = COMMANDS.createBinderItem(db.adapter, {
      projectId: other,
      parentId: null,
      type: "folder",
      title: "Theirs",
    });
    expect(() => create("Ours", foreign.id)).toThrow(/not in this project/i);
  });
});

describe("renameBinderItem", () => {
  it("renames and queues an update", () => {
    const folder = create("Act I");
    db.adapter.run("DELETE FROM pending_change;"); // pretend it synced
    COMMANDS.renameBinderItem(db.adapter, { projectId, id: folder.id, title: "Act One" });

    expect(item(folder.id).title).toBe("Act One");
    expect(queued()[0]).toMatchObject({ op: "update", entity_id: folder.id });
  });

  it("keeps a pending create as a create", () => {
    const folder = create("Act I");
    COMMANDS.renameBinderItem(db.adapter, { projectId, id: folder.id, title: "Act One" });
    // Downgrading to "update" would push an edit for a row the server has never seen.
    const rows = queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("create");
    expect(JSON.parse(rows[0]!.payload!)).toMatchObject({ title: "Act One" });
  });

  it("refuses to rename the trash", () => {
    expect(() =>
      COMMANDS.renameBinderItem(db.adapter, { projectId, id: trashId(), title: "Bin" }),
    ).toThrow(/trash/i);
  });
});

describe("moveBinderItem", () => {
  it("reorders within a parent without touching the others", () => {
    const a = create("Act I");
    create("Act II");
    create("Act III");
    // Fractional keys mean only the moved row is rewritten.
    COMMANDS.moveBinderItem(db.adapter, { projectId, id: a.id, parentId: null, afterId: null });
    expect(childrenOf(null)).toEqual(["Act I", "Act II", "Act III"]);

    const third = db.adapter.query<BinderItemRow>(
      "SELECT * FROM binder_item WHERE title = 'Act III';",
    )[0]!;
    COMMANDS.moveBinderItem(db.adapter, { projectId, id: third.id, parentId: null, afterId: null });
    expect(childrenOf(null)).toEqual(["Act III", "Act I", "Act II"]);
  });

  it("reparents into a folder", () => {
    const act = create("Act I");
    const scene = create("Scene 1");
    COMMANDS.moveBinderItem(db.adapter, { projectId, id: scene.id, parentId: act.id, afterId: null });
    expect(childrenOf(act.id)).toEqual(["Scene 1"]);
    expect(childrenOf(null)).toEqual(["Act I"]);
  });

  it("refuses to move an item into itself", () => {
    const act = create("Act I");
    expect(() =>
      COMMANDS.moveBinderItem(db.adapter, { projectId, id: act.id, parentId: act.id, afterId: null }),
    ).toThrow(/inside itself/i);
  });

  it("refuses to move an item into its own child", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    expect(() =>
      COMMANDS.moveBinderItem(db.adapter, { projectId, id: act.id, parentId: scene.id, afterId: null }),
    ).toThrow(/inside itself/i);
  });

  it("refuses to move an item into a deep descendant", () => {
    // The case a shallow parent check misses. Without the recursive walk the whole
    // subtree detaches: the rows survive but every read starts at a root, so the
    // chapters render nowhere at all.
    const a = create("A");
    const b = create("B", a.id);
    const c = create("C", b.id);
    const d = create("D", c.id);
    expect(() =>
      COMMANDS.moveBinderItem(db.adapter, { projectId, id: a.id, parentId: d.id, afterId: null }),
    ).toThrow(/inside itself/i);
    expect(item(a.id).parent_id).toBeNull();
  });

  it("refuses a destination in another project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Other" }).id;
    const foreign = COMMANDS.createBinderItem(db.adapter, {
      projectId: other, parentId: null, type: "folder", title: "Theirs",
    });
    const mine = create("Mine");
    expect(() =>
      COMMANDS.moveBinderItem(db.adapter, { projectId, id: mine.id, parentId: foreign.id, afterId: null }),
    ).toThrow(/not in this project/i);
  });
});

describe("trashBinderItem", () => {
  it("moves the item to the trash and remembers where it came from", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: scene.id });

    const row = item(scene.id);
    expect(row.parent_id).toBe(trashId());
    expect(row.trashed_from_parent_id).toBe(act.id);
    // Trashing is a move. deleted_at is for the tombstone written when trash is emptied.
    expect(row.deleted_at).toBeNull();
  });

  it("does not overwrite the origin when an item is trashed twice", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: scene.id });
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: scene.id });

    // Recording the trash node as the origin makes the item permanently
    // unrestorable: restore would put it back where it already is.
    expect(item(scene.id).trashed_from_parent_id).toBe(act.id);
  });

  it("refuses to trash the trash", () => {
    expect(() => COMMANDS.trashBinderItem(db.adapter, { projectId, id: trashId() })).toThrow(/trash/i);
  });

  it("keeps the children with their parent", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act.id });
    // The subtree travels intact, so restoring brings the scenes back too.
    expect(item(scene.id).parent_id).toBe(act.id);
    expect(item(scene.id).deleted_at).toBeNull();
  });
});

describe("restoreBinderItem", () => {
  it("puts the item back where it was", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: scene.id });
    COMMANDS.restoreBinderItem(db.adapter, { projectId, id: scene.id });

    expect(item(scene.id).parent_id).toBe(act.id);
    expect(item(scene.id).trashed_from_parent_id).toBeNull();
  });

  it("leaves a live item exactly where it is", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    // Restoring something that was never trashed must not relocate it to the root,
    // which would move a document the author is looking at.
    COMMANDS.restoreBinderItem(db.adapter, { projectId, id: scene.id });
    expect(item(scene.id).parent_id).toBe(act.id);
  });

  it("falls back to the root when the original parent is in the trash", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: scene.id });
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act.id });
    COMMANDS.restoreBinderItem(db.adapter, { projectId, id: scene.id });

    // Refusing would strand the item where the author cannot reach it.
    expect(item(scene.id).parent_id).toBeNull();
  });
});

describe("emptyTrash", () => {
  it("tombstones every item in every trashed subtree", () => {
    const act = create("Act I");
    const scene = create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act.id });

    expect(COMMANDS.emptyTrash(db.adapter, { projectId })).toEqual({ deleted: 2 });
    // A child left live under a vanished parent renders nowhere and syncs nothing.
    expect(item(act.id).deleted_at).not.toBeNull();
    expect(item(scene.id).deleted_at).not.toBeNull();
  });

  it("keeps the rows, because the tombstone is what tells other devices", () => {
    const act = create("Act I");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act.id });
    COMMANDS.emptyTrash(db.adapter, { projectId });
    expect(db.adapter.query("SELECT id FROM binder_item WHERE id = ?;", [act.id])).toHaveLength(1);
  });

  it("leaves items outside the trash alone", () => {
    const kept = create("Act I");
    const discarded = create("Act II");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: discarded.id });
    COMMANDS.emptyTrash(db.adapter, { projectId });
    expect(item(kept.id).deleted_at).toBeNull();
  });

  it("queues a delete for each tombstoned item", () => {
    const act = create("Act I");
    create("Scene 1", act.id);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act.id });
    db.adapter.run("DELETE FROM pending_change;"); // pretend everything synced
    COMMANDS.emptyTrash(db.adapter, { projectId });

    const rows = queued();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.op === "delete")).toBe(true);
  });
});

describe("the queue's base_version", () => {
  it("records the version last seen from the server, not a local guess", () => {
    const folder = create("Act I");
    db.adapter.run("DELETE FROM pending_change;");
    // Pretend the server has accepted this row twice since.
    db.adapter.run("UPDATE binder_item SET version = 7 WHERE id = ?;", [folder.id]);

    COMMANDS.renameBinderItem(db.adapter, { projectId, id: folder.id, title: "Act One" });
    expect(queued()[0]!.base_version).toBe(7);
    // Local edits must not bump version — the server assigns it, and inventing one
    // makes every push look conflict-free.
    expect(item(folder.id).version).toBe(7);
  });
});
