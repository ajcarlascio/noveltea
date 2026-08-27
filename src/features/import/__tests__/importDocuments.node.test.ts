// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import type { DatabaseClient } from "@/db/client";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";
import { importDocuments, MAX_IMPORT_BYTES } from "../importDocuments";

/**
 * Importing, against a real SQLite replica.
 *
 * Not a mocked database: what is worth pinning here is that an import lands as an
 * ordinary local edit — a binder row, a document body, and a queue entry for each —
 * and a mocked command layer would assert only that the code called itself.
 */

let db: TestDatabase;
let projectId: string;

/** The worker client's surface, dispatched straight at the test adapter. */
const client = () =>
  ({
    command: (name: string, input: unknown) =>
      Promise.resolve(
        (COMMANDS as unknown as Record<string, (a: unknown, b: unknown) => unknown>)[name]?.(
          db.adapter,
          input,
        ),
      ),
  }) as unknown as DatabaseClient;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  db.adapter.run("DELETE FROM pending_change;");
});
afterEach(() => db.close());

const rows = <T,>(sql: string, params: readonly (string | number | null)[] = []) =>
  db.adapter.query<T>(sql, params);

describe("importDocuments", () => {
  it("creates a document per file, titled from the file name, with its prose inside", async () => {
    const outcome = await importDocuments(client(), projectId, null, [
      { fileName: "chapter-one.md", text: "# Chapter One\n\nThe lighthouse stood alone." },
      { fileName: "chapter-two.txt", text: "Nobody had lit it in years." },
    ]);

    expect(outcome.errors).toEqual([]);
    expect(outcome.created).toHaveLength(2);

    const items = rows<{ id: string; title: string; type: string }>(
      "SELECT id, title, type FROM binder_item WHERE project_id = ? AND type = 'document' ORDER BY order_key;",
      [projectId],
    );
    expect(items.map((item) => item.title)).toEqual(["chapter one", "chapter two"]);

    // The body is read back from the replica, not from what the function returned:
    // a bug that wrote and read symmetrically would survive the weaker check.
    const body = rows<{ content: string; word_count: number; search_text: string }>(
      "SELECT content, word_count, search_text FROM document WHERE id = ?;",
      [outcome.created[0]!],
    )[0]!;
    expect(JSON.parse(body.content)).toMatchObject({
      type: "doc",
      content: [{ type: "heading", attrs: { level: 1 } }, { type: "paragraph" }],
    });
    expect(body.search_text).toContain("The lighthouse stood alone.");
    expect(body.word_count).toBe(6);
  });

  it("queues every import for sync, so an offline import is not a local-only document", async () => {
    const outcome = await importDocuments(client(), projectId, null, [
      { fileName: "scene.txt", text: "Some prose." },
    ]);

    const queued = rows<{ entity_type: string; entity_id: string; op: string }>(
      "SELECT entity_type, entity_id, op FROM pending_change ORDER BY id;",
    );
    const forDocument = queued.filter((row) => row.entity_id === outcome.created[0]);
    expect(forDocument.map((row) => row.entity_type).sort()).toEqual(["binder_item", "document"]);
  });

  it("places the imports under the parent it was given", async () => {
    const folder = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Act One",
    });

    const outcome = await importDocuments(client(), projectId, folder.id, [
      { fileName: "scene.md", text: "Prose." },
    ]);

    expect(
      rows<{ parent_id: string | null }>("SELECT parent_id FROM binder_item WHERE id = ?;", [
        outcome.created[0]!,
      ])[0]?.parent_id,
    ).toBe(folder.id);
  });

  it("refuses a file type it cannot read, and imports the rest of the batch anyway", async () => {
    // Four good chapters out of five is what an author wants; refusing all five
    // because one was a .docx is not.
    const outcome = await importDocuments(client(), projectId, null, [
      { fileName: "good.md", text: "Prose." },
      { fileName: "manuscript.docx", text: "binary-ish" },
      { fileName: "also-good.txt", text: "More prose." },
    ]);

    expect(outcome.created).toHaveLength(2);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toMatch(/manuscript\.docx.*not a text or Markdown file/);
    expect(
      rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM binder_item WHERE project_id = ? AND type = 'document';",
        [projectId],
      )[0]?.n,
    ).toBe(2);
  });

  it("refuses a file too large to read without locking the tab", async () => {
    const outcome = await importDocuments(client(), projectId, null, [
      { fileName: "huge.txt", text: "x".repeat(MAX_IMPORT_BYTES + 1) },
    ]);

    expect(outcome.created).toEqual([]);
    expect(outcome.errors[0]).toMatch(/larger than 5 MB/);
    expect(
      rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM binder_item WHERE project_id = ? AND type = 'document';",
        [projectId],
      )[0]?.n,
    ).toBe(0);
  });

  it("imports an empty file as an empty document rather than failing", async () => {
    const outcome = await importDocuments(client(), projectId, null, [
      { fileName: "blank.txt", text: "" },
    ]);
    expect(outcome.errors).toEqual([]);
    expect(
      JSON.parse(
        rows<{ content: string }>("SELECT content FROM document WHERE id = ?;", [
          outcome.created[0]!,
        ])[0]!.content,
      ),
    ).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});
