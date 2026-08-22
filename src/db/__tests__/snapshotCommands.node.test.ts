// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { KEEP_AUTOMATIC_PER_DOCUMENT } from "@/db/snapshot-commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;
let documentId: string;

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  documentId = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id: documentId,
    content: doc("She climbed the stair by lamplight."),
    searchText: "She climbed the stair by lamplight.",
    wordCount: 6,
  });
  db.adapter.run("DELETE FROM pending_change;"); // pretend everything so far synced
});

afterEach(() => db.close());

const capture = (over: Partial<Parameters<typeof COMMANDS.captureSnapshot>[1]> = {}) =>
  COMMANDS.captureSnapshot(db.adapter, {
    projectId,
    documentId,
    label: "Before the rewrite",
    automatic: false,
    ...over,
  });

const snapshots = () =>
  db.adapter.query<{ id: string; label: string | null; is_automatic: number; word_count: number; content: string }>(
    "SELECT id, label, is_automatic, word_count, content FROM snapshot ORDER BY created_at DESC, id DESC;",
  );

const queued = () => db.adapter.query<PendingChange>("SELECT * FROM pending_change ORDER BY id;");

const document = () =>
  db.adapter.query<{ content: string; search_text: string | null; word_count: number; version: number }>(
    "SELECT content, search_text, word_count, version FROM document WHERE id = ?;",
    [documentId],
  )[0]!;

describe("captureSnapshot", () => {
  it("stores the document as it stands, with its word count", () => {
    capture();
    const [row] = snapshots();
    expect(JSON.parse(row!.content)).toEqual(doc("She climbed the stair by lamplight."));
    expect(row!.word_count).toBe(6);
    expect(row!.label).toBe("Before the rewrite");
  });

  it("queues a manual snapshot for push", () => {
    capture();
    const [change] = queued();
    expect(change?.entity_type).toBe("snapshot");
    expect(change?.op).toBe("create");
  });

  it("keeps an automatic snapshot on this device", () => {
    // Automatic captures are this device's safety net and are pruned to a bound.
    // Pushing them would put every device's undo history on every other device.
    capture({ automatic: true, label: null });
    expect(snapshots()).toHaveLength(1);
    expect(queued()).toHaveLength(0);
  });

  it("takes a blank label as no label rather than an empty one", () => {
    capture({ label: "   " });
    expect(snapshots()[0]?.label).toBeNull();
  });

  it("refuses a document from another project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    // Without scoping, an id learned from anywhere would capture another book's prose.
    expect(() => capture({ projectId: other })).toThrow(/not in this project/i);
  });
});

describe("pruning", () => {
  it("keeps automatic captures to the bound, oldest dropped first", () => {
    for (let i = 0; i < KEEP_AUTOMATIC_PER_DOCUMENT + 5; i += 1) {
      capture({ automatic: true, label: null });
      // created_at has second-and-below resolution in ISO form; without distinct
      // stamps the ORDER BY falls back to id and the assertion proves nothing.
      db.adapter.run(
        "UPDATE snapshot SET created_at = ? WHERE created_at = (SELECT MAX(created_at) FROM snapshot);",
        [new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()],
      );
    }
    expect(snapshots()).toHaveLength(KEEP_AUTOMATIC_PER_DOCUMENT);
  });

  it("never prunes a manual snapshot", () => {
    // A manual snapshot is something the author asked for by name. Deleting it on
    // their behalf to make room for the editor's own captures is not the deal.
    capture({ label: "Keep me" });
    for (let i = 0; i < KEEP_AUTOMATIC_PER_DOCUMENT + 5; i += 1) {
      capture({ automatic: true, label: null });
    }
    expect(snapshots().filter((row) => row.label === "Keep me")).toHaveLength(1);
  });
});

describe("restoreSnapshot", () => {
  const older = () => {
    const id = capture({ label: "The first draft" }).id;
    COMMANDS.saveDocument(db.adapter, {
      projectId,
      id: documentId,
      content: doc("She climbed the stair in the dark."),
      searchText: "She climbed the stair in the dark.",
      wordCount: 7,
    });
    db.adapter.run("DELETE FROM pending_change;");
    return id;
  };

  it("puts the old content back", () => {
    COMMANDS.restoreSnapshot(db.adapter, { projectId, id: older() });
    expect(JSON.parse(document().content)).toEqual(doc("She climbed the stair by lamplight."));
    expect(document().word_count).toBe(6);
  });

  it("recomputes the search text", () => {
    // The snapshot row does not store search_text. Carrying the old one forward, or
    // leaving it alone, means offline search keeps matching prose that is now gone —
    // the one kind of stale result nothing on screen would reveal.
    COMMANDS.restoreSnapshot(db.adapter, { projectId, id: older() });
    expect(document().search_text).toContain("by lamplight");
    expect(document().search_text).not.toContain("in the dark");
  });

  it("captures the current state first, so the restore is undoable", () => {
    COMMANDS.restoreSnapshot(db.adapter, { projectId, id: older() });
    const before = snapshots().find((row) => row.label === "Before restore");
    expect(before).toBeDefined();
    expect(JSON.parse(before!.content)).toEqual(doc("She climbed the stair in the dark."));
    expect(before!.is_automatic).toBe(1);
  });

  it("queues the document, not the snapshot, against the version last synced", () => {
    const id = older();
    db.adapter.run("UPDATE document SET version = 9 WHERE id = ?;", [documentId]);
    COMMANDS.restoreSnapshot(db.adapter, { projectId, id });

    const changes = queued();
    expect(changes.map((change) => change.entity_type)).toEqual(["document"]);
    expect(changes[0]?.base_version).toBe(9);
    // A restore is an ordinary local edit that happens to replace the whole body;
    // the server assigns versions, so bumping it here would push a base the server
    // has never issued.
    expect(document().version).toBe(9);
  });
});

describe("deleteSnapshot", () => {
  it("queues a delete for one the server has seen", () => {
    const id = capture().id;
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.deleteSnapshot(db.adapter, { projectId, id });

    expect(snapshots()).toHaveLength(0);
    expect(queued().map((change) => change.op)).toEqual(["delete"]);
  });

  it("says nothing to the server about an automatic one", () => {
    // It never got there. A delete for a row the server has never heard of is a
    // phantom that would be refused on every push until something gave up.
    const id = capture({ automatic: true, label: null }).id;
    COMMANDS.deleteSnapshot(db.adapter, { projectId, id });

    expect(snapshots()).toHaveLength(0);
    expect(queued()).toHaveLength(0);
  });

  it("refuses a snapshot from another project", () => {
    const id = capture().id;
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    expect(() => COMMANDS.deleteSnapshot(db.adapter, { projectId: other, id })).toThrow(
      /not in this project/i,
    );
  });
});
