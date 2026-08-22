// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { planProject } from "@/data/preflight";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * The pre-flight runs the compile worker's own planner over the local replica, so what
 * is pinned here is the query feeding it — most of all that it hands over the trash.
 */

let db: TestDatabase;
let projectId: string;

/** listComments-style async wrapper over the synchronous test adapter. */
const reader = {
  query: <T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> =>
    Promise.resolve(db.adapter.query<T>(sql, params)),
};

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

function document(title: string, text: string | null, parentId: string | null = null): string {
  const id = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId,
    type: "document",
    title,
  }).id;
  if (text !== null) {
    COMMANDS.saveDocument(db.adapter, {
      projectId,
      id,
      content: doc(text),
      searchText: text,
      wordCount: text.split(" ").length,
    });
  }
  return id;
}

const codes = (plan: Awaited<ReturnType<typeof planProject>>) =>
  plan.warnings.map((warning) => warning.code);

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
});

afterEach(() => db.close());

describe("planProject", () => {
  it("includes documents that have prose, in binder order", async () => {
    document("Chapter One", "She climbed the stair.");
    document("Chapter Two", "Morning came slowly.");

    const plan = await planProject(reader, projectId);
    expect(plan.included.map((item) => item.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(plan.wordCount).toBeGreaterThan(0);
  });

  it("warns that a folder holds no text", async () => {
    COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Act One",
    });
    const plan = await planProject(reader, projectId);
    expect(codes(plan)).toContain("not_convertible");
    expect(plan.included).toHaveLength(0);
  });

  it("warns that an empty document contributes nothing", async () => {
    document("Chapter One", null);
    const plan = await planProject(reader, projectId);
    expect(codes(plan)).toContain("empty_document");
    expect(plan.included).toHaveLength(0);
  });

  it("EXCLUDES A TRASHED CHAPTER AND SAYS SO", async () => {
    // Trashing is a reparent, not a deleted_at write, so a discarded chapter still
    // looks like an ordinary live document — it just sits under the trash node. The
    // planner needs the trash node to see that, which is why the query does not
    // filter it out before handing the binder over.
    const id = document("Cut scene", "Words nobody wants published.");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id });

    const plan = await planProject(reader, projectId);
    expect(codes(plan)).toContain("excluded_trashed");
    expect(plan.included.map((item) => item.title)).not.toContain("Cut scene");
  });

  it("says plainly that synopses and notes are never exported", async () => {
    const id = document("Chapter One", "She climbed the stair.");
    db.adapter.run("UPDATE document SET synopsis = ? WHERE id = ?;", ["She goes up", id]);

    const plan = await planProject(reader, projectId);
    expect(codes(plan)).toContain("notes_not_exported");
    // The chapter itself is still compiled; the note beside it simply is not.
    expect(plan.included.map((item) => item.title)).toEqual(["Chapter One"]);
  });

  it("treats content that is not a document as one with no text", async () => {
    // A CHECK keeps malformed JSON out of the column, so the case that can actually
    // arrive is JSON that parses to something other than a document — from a version
    // of the app that stored it differently. It is an empty chapter, not a crash.
    const id = document("Chapter One", "prose");
    db.adapter.run("UPDATE document SET content = ? WHERE id = ?;", ["null", id]);

    const plan = await planProject(reader, projectId);
    expect(codes(plan)).toContain("empty_document");
  });
});
