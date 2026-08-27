// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { loadCompilePresets } from "@/data/compile-presets";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;
let chapterId: string;

const reader = {
  query: <T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> =>
    Promise.resolve(db.adapter.query<T>(sql, params)),
};

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  chapterId = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
});

afterEach(() => db.close());

const preset = (name: string, format: string, includedIds: string[] = []) =>
  COMMANDS.createCompilePreset(db.adapter, { projectId, name, format, includedIds });

describe("reading presets", () => {
  it("reads the name, the format and the selection", async () => {
    preset("Agent submission", "html", [chapterId]);
    expect(await loadCompilePresets(reader, projectId)).toEqual([
      {
        id: expect.any(String) as string,
        name: "Agent submission",
        format: "html",
        includedIds: [chapterId],
      },
    ]);
  });

  it("leaves out tombstoned ones", async () => {
    const row = preset("Agent submission", "html");
    COMMANDS.deleteCompilePreset(db.adapter, { projectId, id: row.id });
    expect(await loadCompilePresets(reader, projectId)).toHaveLength(0);
  });

  it("reads a format this build does not know as Markdown rather than dropping the preset", async () => {
    // The row arrived from a newer client through sync. The author's name and selection
    // are still their work, and losing the whole preset over a format string would be a
    // worse answer than showing it in one this build can produce.
    const row = preset("Agent submission", "html");
    db.adapter.run("PRAGMA ignore_check_constraints = ON;");
    db.adapter.run("UPDATE compile_preset SET format = 'inkjet' WHERE id = ?;", [row.id]);
    db.adapter.run("PRAGMA ignore_check_constraints = OFF;");

    const [loaded] = await loadCompilePresets(reader, projectId);
    expect(loaded?.format).toBe("md");
    expect(loaded?.name).toBe("Agent submission");
  });

  it("reads a selection that is not a list of ids as the whole manuscript", async () => {
    // A CHECK keeps malformed JSON out, so what can actually arrive is JSON of another
    // shape. Everything is the safe wrong answer: the author sees too much in the
    // pre-flight and says so, where reading it as "nothing" would silently compile a
    // blank book.
    const row = preset("Agent submission", "html", [chapterId]);
    db.adapter.run("UPDATE compile_preset SET included_binder_items = '{}' WHERE id = ?;", [
      row.id,
    ]);

    const [loaded] = await loadCompilePresets(reader, projectId);
    expect(loaded?.includedIds).toEqual([]);
  });
});
