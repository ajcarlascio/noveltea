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
  db.adapter.run("DELETE FROM pending_change;"); // pretend the create synced
});

afterEach(() => db.close());

const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "The light" }] }] };

const row = () =>
  db.adapter.query<{ content: string; search_text: string | null; word_count: number }>(
    "SELECT content, search_text, word_count FROM document WHERE id = ?;",
    [documentId],
  )[0]!;

const queued = () => db.adapter.query<PendingChange>("SELECT * FROM pending_change ORDER BY id;");

const save = (over: Partial<Parameters<typeof COMMANDS.saveDocument>[1]> = {}) =>
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id: documentId,
    content: body,
    searchText: "The light",
    wordCount: 2,
    ...over,
  });

describe("saveDocument", () => {
  it("captures the content it is replacing when asked, in the same write", () => {
    // Atomic on purpose: the capture has to see the previous content, so a second
    // command after the save would be reading prose that had already gone.
    save({ content: { type: "doc", content: [] }, searchText: "first", wordCount: 1 });
    save({ snapshotBefore: true, searchText: "second", wordCount: 1 });

    const snapshots = db.adapter.query<{ content: string; is_automatic: number }>(
      "SELECT content, is_automatic FROM snapshot;",
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.is_automatic).toBe(1);
    expect(JSON.parse(snapshots[0]?.content ?? "null")).toEqual({ type: "doc", content: [] });
  });

  it("captures nothing when not asked", () => {
    save();
    expect(db.adapter.query("SELECT id FROM snapshot;")).toHaveLength(0);
  });

  it("does not queue the automatic capture for push", () => {
    // It is this device's safety net. Every device's undo history on every other
    // device is not a feature.
    save({ snapshotBefore: true });
    expect(queued().map((change) => change.entity_type)).toEqual(["document"]);
  });

  it("stores the body, the search text and the count", () => {
    save();
    expect(JSON.parse(row().content)).toEqual(body);
    expect(row().search_text).toBe("The light");
    expect(row().word_count).toBe(2);
  });

  it("queues an update carrying the version last synced", () => {
    db.adapter.run("UPDATE document SET version = 4 WHERE id = ?;", [documentId]);
    save();

    const rows = queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "document", entity_id: documentId, op: "update" });
    // Local edits never bump version; inventing one makes every push look
    // conflict-free and silently clobbers another device's edit.
    expect(rows[0]!.base_version).toBe(4);
    expect(row().word_count).toBe(2);
  });

  it("coalesces a typing session into one queue entry", () => {
    save({ searchText: "The", wordCount: 1 });
    save({ searchText: "The light", wordCount: 2 });
    save({ searchText: "The light swung", wordCount: 3 });

    const rows = queued();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload!)).toMatchObject({ word_count: 3 });
  });

  it("refuses a folder", () => {
    const folder = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Act I",
    });
    expect(() => save({ id: folder.id })).toThrow(/not a document/i);
  });

  it("refuses a document in another project", () => {
    // `document` has no project_id of its own; it is scoped through its binder item.
    // Without that an id learned from anywhere would write into someone else's book.
    const other = COMMANDS.createProject(db.adapter, { title: "Other" }).id;
    const theirs = COMMANDS.createBinderItem(db.adapter, {
      projectId: other, parentId: null, type: "document", title: "Theirs",
    });
    expect(() => save({ id: theirs.id })).toThrow(/not in this project/i);
    expect(
      db.adapter.query("SELECT search_text FROM document WHERE id = ?;", [theirs.id])[0],
    ).toMatchObject({ search_text: null });
  });

  it("refuses a tombstoned document", () => {
    db.adapter.run("UPDATE binder_item SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?;", [documentId]);
    expect(() => save()).toThrow(/deleted/i);
  });

  it("refuses a word count that is not a whole number of words", () => {
    expect(() => save({ wordCount: -1 })).toThrow(/word count/i);
    expect(() => save({ wordCount: 1.5 })).toThrow(/word count/i);
  });

  it("stores content verbatim, without interpreting it", () => {
    // The database never walks a document. A node type this build has never met
    // must round-trip untouched, or a newer client's work is quietly flattened.
    const exotic = { type: "doc", content: [{ type: "sceneBreak", attrs: { glyph: "* * *" } }] };
    save({ content: exotic });
    expect(JSON.parse(row().content)).toEqual(exotic);
  });
});
