// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;
let documentId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  documentId = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const anchor = { from: 3, to: 12, quotedText: "the stair" };

const add = (over: Partial<Parameters<typeof COMMANDS.addComment>[1]> = {}) =>
  COMMANDS.addComment(db.adapter, {
    projectId,
    documentId,
    body: "is this too slow?",
    anchor,
    parentId: null,
    ...over,
  });

const rows = () =>
  db.adapter.query<{
    id: string;
    body: string;
    anchor: string | null;
    parent_comment_id: string | null;
    resolved_at: string | null;
    deleted_at: string | null;
  }>("SELECT id, body, anchor, parent_comment_id, resolved_at, deleted_at FROM comment ORDER BY created_at, id;");

/**
 * One comment by id.
 *
 * Indexing into `rows()` is not safe: comments created in the same millisecond share a
 * created_at, so the order falls back to a random uuid and the assertion becomes a coin
 * flip. It is also how a hard delete slips past `rows()[0]?.field` — undefined is not
 * null, and the expectation passes with the row gone.
 */
const byId = (id: string) =>
  db.adapter.query<{
    id: string;
    body: string;
    anchor: string | null;
    resolved_at: string | null;
    deleted_at: string | null;
  }>(
    "SELECT id, body, anchor, resolved_at, deleted_at FROM comment WHERE id = ?;",
    [id],
  )[0];

const queued = () => db.adapter.query<PendingChange>("SELECT * FROM pending_change ORDER BY id;");
const payloadOf = (change: PendingChange | undefined) =>
  JSON.parse(change?.payload ?? "null") as Record<string, unknown> | null;

describe("addComment", () => {
  it("stores the note with its anchor and queues a create", () => {
    const stored = byId(add().id);
    expect(stored?.body).toBe("is this too slow?");
    expect(JSON.parse(stored?.anchor ?? "null")).toEqual(anchor);
    expect(queued()[0]?.entity_type).toBe("comment");
    expect(queued()[0]?.op).toBe("create");
  });

  it("never sends an author", () => {
    // The server takes authorship from the pushing device's owner. A client that
    // could name one could attribute a remark to somebody who never made it.
    add();
    expect(payloadOf(queued()[0])).not.toHaveProperty("author_user_id");
  });

  it("refuses an empty note", () => {
    expect(() => add({ body: "   " })).toThrow(/needs something in it/i);
    expect(rows()).toHaveLength(0);
  });

  it("strips a reply's own anchor, leaving the thread's", () => {
    // The schema refuses both at once, and a thread pointing at two passages is not
    // a thread.
    const parent = add().id;
    const reply = byId(add({ parentId: parent, body: "I think so", anchor }).id);
    expect(reply).toBeDefined();
    expect(reply?.anchor).toBeNull();
  });

  it("refuses a reply to a thread on another document", () => {
    const other = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "document",
      title: "Chapter Two",
    }).id;
    const parent = add().id;
    expect(() => add({ documentId: other, parentId: parent })).toThrow(/another document/i);
  });

  it("refuses a reply to a reply", () => {
    const parent = add().id;
    const reply = add({ parentId: parent, body: "I think so" }).id;
    expect(() => add({ parentId: reply, body: "nested" })).toThrow(/replies of their own/i);
  });

  it("refuses a document from another project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    expect(() => add({ projectId: other })).toThrow(/not in this project/i);
  });
});

describe("editComment and resolveComment", () => {
  it("sends the whole state, so a coalesced edit is not lost behind a resolve", () => {
    // pending_change holds one row per entity and coalesces by replacing the payload.
    // Sending only the field that changed means an edit then a resolve arrives as a
    // resolve, with the edit gone.
    const id = add().id;
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.editComment(db.adapter, { projectId, id, body: "far too slow" });
    COMMANDS.resolveComment(db.adapter, { projectId, id, resolved: true });

    expect(queued()).toHaveLength(1);
    expect(payloadOf(queued()[0])).toMatchObject({ body: "far too slow", resolved: true });
  });

  it("keeps the base version from the first of the two", () => {
    const id = add().id;
    db.adapter.run("UPDATE comment SET version = 4 WHERE id = ?;", [id]);
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.editComment(db.adapter, { projectId, id, body: "far too slow" });
    COMMANDS.resolveComment(db.adapter, { projectId, id, resolved: true });

    expect(queued()[0]?.base_version).toBe(4);
  });

  it("reopens a thread", () => {
    const id = add().id;
    COMMANDS.resolveComment(db.adapter, { projectId, id, resolved: true });
    COMMANDS.resolveComment(db.adapter, { projectId, id, resolved: false });

    expect(byId(id)?.resolved_at).toBeNull();
    expect(payloadOf(queued()[0])).toMatchObject({ resolved: false });
  });

  it("refuses to empty a note by editing it", () => {
    const id = add().id;
    expect(() => COMMANDS.editComment(db.adapter, { projectId, id, body: "" })).toThrow(
      /needs something in it/i,
    );
    expect(byId(id)?.body).toBe("is this too slow?");
  });
});

describe("deleteComment", () => {
  it("tombstones rather than removing, and queues a delete", () => {
    // A hard delete would come back on the next pull: the server keeps its own
    // tombstone, and a row that is simply absent looks like one this device has
    // never seen.
    const id = add().id;
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.deleteComment(db.adapter, { projectId, id });

    const tombstone = byId(id);
    // Asserted on the row, not through an optional chain: with the row gone,
    // `rows()[0]?.deleted_at` is undefined, and undefined is not null.
    expect(tombstone).toBeDefined();
    expect(tombstone?.deleted_at).not.toBeNull();
    expect(queued()[0]?.op).toBe("delete");
  });

  it("refuses a comment from another project", () => {
    const id = add().id;
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    expect(() => COMMANDS.deleteComment(db.adapter, { projectId: other, id })).toThrow(
      /not in this project/i,
    );
  });

  it("will not act on an already-deleted comment", () => {
    const id = add().id;
    COMMANDS.deleteComment(db.adapter, { projectId, id });
    expect(() => COMMANDS.editComment(db.adapter, { projectId, id, body: "again" })).toThrow(
      /not in this project/i,
    );
  });
});
