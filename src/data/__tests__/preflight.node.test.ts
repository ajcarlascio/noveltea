// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { narrowPlan, planProject } from "@/data/preflight";
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

describe("narrowing to a preset's selection", () => {
  it("counts only the selected chapters, and their words", async () => {
    const one = document("Chapter One", "She climbed the stair by lamplight.");
    document("Chapter Two", "He waited at the foot of it.");

    const plan = await planProject(reader, projectId, [one]);
    expect(plan.included.map((item) => item.title)).toEqual(["Chapter One"]);
    // Recounted from the selected text with the compiler's own extraction, not carried
    // over from the whole project. A pre-flight that reported the book's word count
    // while exporting one chapter is the lie this exists to prevent.
    expect(plan.wordCount).toBe(6);
  });

  it("still recognises a trashed chapter inside the selection", async () => {
    // The planner needs the trash node and everything under it to see a discarded
    // chapter at all — trashing is a reparent, not a deleted_at write. Narrowing after
    // the plan is what keeps that working; filtering the rows first would hand the
    // planner a binder with no trash in it and the chapter would compile.
    const id = document("Chapter One", "Words nobody wants published.");
    COMMANDS.trashBinderItem(db.adapter, { projectId, id });

    const plan = await planProject(reader, projectId, [id]);
    expect(plan.included).toHaveLength(0);
    expect(codes(plan)).toContain("excluded_trashed");
  });

  it("keeps warnings that are about the compile rather than an item", async () => {
    const one = document("Chapter One", "She climbed the stair.");
    document("Chapter Two", "He waited.");
    db.adapter.run("UPDATE document SET synopsis = ? WHERE id = ?;", ["She goes up", one]);

    const plan = await planProject(reader, projectId, [one]);
    expect(codes(plan)).toContain("notes_not_exported");
    // Chapter Two is not in this export, so nothing about it belongs in the notice.
    expect(plan.warnings.some((warning) => warning.itemTitle === "Chapter Two")).toBe(false);
  });

  it("treats an empty selection as the whole manuscript", () => {
    // The same reading the compile worker uses: it filters only when the list is
    // non-empty. If these two ever disagree, an author exports a blank book.
    const plan = { included: [{ id: "a", title: "One", type: "document", depth: 0, hasText: true }], warnings: [], wordCount: 3 };
    expect(narrowPlan(plan, [])).toBe(plan);
  });
});
