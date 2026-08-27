// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * Compile presets, against the real schema.
 *
 * Half of these are about the queued payload rather than the row, because the payload is
 * the part with a second reader: the server's `SyncEntitySpec` binds
 * `included_binder_items` as a Postgres `uuid[]` and `separator_rules` as jsonb, and
 * refuses the push outright when the shape is wrong. A local row that looks right and a
 * payload that is rejected is exactly the failure this file exists to catch — the author
 * sees a saved preset and no other device ever does.
 */

let db: TestDatabase;
let projectId: string;
let chapterOne: string;
let chapterTwo: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  chapterOne = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
  chapterTwo = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter Two",
  }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const preset = (name: string, format: string, includedIds: string[] = []) =>
  COMMANDS.createCompilePreset(db.adapter, { projectId, name, format, includedIds });

const queuedFor = (entityId: string) =>
  db.adapter
    .query<PendingChange>("SELECT * FROM pending_change;")
    .find((row) => row.entity_type === "compile_preset" && row.entity_id === entityId);

const payloadOf = (entityId: string) =>
  JSON.parse(queuedFor(entityId)?.payload ?? "null") as Record<string, unknown>;

describe("creating a preset", () => {
  it("stores the format and the selection", () => {
    const row = preset("Agent submission", "html", [chapterOne]);
    expect(row.format).toBe("html");
    expect(JSON.parse(row.included_binder_items!)).toEqual([chapterOne]);
  });

  it("refuses a blank name", () => {
    expect(() => preset("   ", "md")).toThrow(/needs a name/i);
  });

  it("refuses a format that is not one", () => {
    // Caught here rather than left to the CHECK constraint, which reaches an author as
    // raw SQL, and rather than left to the server, which would reject the push after
    // the row was already saved.
    expect(() => preset("Nonsense", "pages")).toThrow(/not an export format/i);
  });

  it("accepts a commercial format this edition cannot compile", () => {
    // A preset is a description of a submission, not a promise about this build. An
    // author on Core can write down that their agent wants DOCX; the compile refuses,
    // with a message about the edition, and the preset survives the upgrade.
    expect(preset("For the agent", "docx").format).toBe("docx");
  });

  it("drops ids that name nothing in this project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    const stranger = COMMANDS.createBinderItem(db.adapter, {
      projectId: other,
      parentId: null,
      type: "document",
      title: "Not mine",
    }).id;

    const row = preset("Mixed", "md", [chapterOne, stranger, "not-an-id"]);
    expect(JSON.parse(row.included_binder_items!)).toEqual([chapterOne]);
  });

  it("keeps an empty selection, which is how the whole manuscript is written down", () => {
    // Not null: the schema's `compile_preset_has_selection` CHECK and the server's
    // invariant of the same name both need a selection to be present, and the compile
    // worker only filters when the list is non-empty. Empty means everything on both
    // sides, and that agreement is the whole contract.
    const row = preset("Everything", "md");
    expect(row.included_binder_items).toBe("[]");
    expect(payloadOf(row.id).included_binder_items).toEqual([]);
  });
});

describe("what reaches the server", () => {
  it("sends the selection as an array of ids, not a JSON string", () => {
    // The column is uuid[]; the writer parses every element with UUID.fromString. A
    // string holding "[\"...\"]" is one value, and it is not a uuid.
    const row = preset("First three", "html", [chapterOne, chapterTwo]);
    const payload = payloadOf(row.id);
    expect(Array.isArray(payload.included_binder_items)).toBe(true);
    expect(payload.included_binder_items).toEqual([chapterOne, chapterTwo]);
  });

  it("sends separator rules as an object", () => {
    // JSON_OBJECT is checked with isObject() and refused otherwise — a string holding
    // "{}" is not coerced, it is an invalid_request that fails the whole push.
    const row = preset("Plain", "md");
    expect(payloadOf(row.id).separator_rules).toEqual({});
  });

  it("sends every id as a real uuid", () => {
    const row = preset("First three", "html", [chapterOne, chapterTwo]);
    const ids = payloadOf(row.id).included_binder_items as string[];
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  it("queues the whole row on an update, not the field that changed", () => {
    // pending_change keeps one entry per entity and coalesces by replacing the payload,
    // so a partial one would erase what an earlier edit put there.
    const row = preset("Agent submission", "html", [chapterOne]);
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.updateCompilePreset(db.adapter, { projectId, id: row.id, format: "md" });
    const payload = payloadOf(row.id);
    expect(payload.name).toBe("Agent submission");
    expect(payload.format).toBe("md");
    expect(payload.included_binder_items).toEqual([chapterOne]);
  });

  it("pushes the base version the server last acknowledged", () => {
    const row = preset("Agent submission", "html");
    expect(queuedFor(row.id)?.base_version).toBe(row.version);
  });
});

describe("updating a preset", () => {
  it("leaves the selection alone when none is given", () => {
    const row = preset("Agent submission", "html", [chapterOne]);
    const after = COMMANDS.updateCompilePreset(db.adapter, {
      projectId,
      id: row.id,
      name: "Contest entry",
    });
    expect(after.name).toBe("Contest entry");
    expect(JSON.parse(after.included_binder_items!)).toEqual([chapterOne]);
  });

  it("replaces the selection when one is given, including with nothing", () => {
    const row = preset("Agent submission", "html", [chapterOne, chapterTwo]);
    const after = COMMANDS.updateCompilePreset(db.adapter, {
      projectId,
      id: row.id,
      includedIds: [],
    });
    expect(JSON.parse(after.included_binder_items!)).toEqual([]);
  });

  it("refuses a preset from another project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    const row = preset("Agent submission", "html");
    expect(() =>
      COMMANDS.updateCompilePreset(db.adapter, { projectId: other, id: row.id, name: "Theirs" }),
    ).toThrow(/not in this project/i);
  });
});

describe("deleting a preset", () => {
  it("tombstones it and stops listing it", () => {
    const row = preset("Agent submission", "html");
    COMMANDS.deleteCompilePreset(db.adapter, { projectId, id: row.id });

    expect(COMMANDS.listCompilePresets(db.adapter, { projectId })).toHaveLength(0);
    const still = db.adapter.query<{ deleted_at: string | null }>(
      "SELECT deleted_at FROM compile_preset WHERE id = ?;",
      [row.id],
    )[0];
    expect(still?.deleted_at).not.toBeNull();
  });

  it("collapses with its own create when the server has never seen it", () => {
    // enqueueChange drops create-then-delete while attempts = 0: nothing was ever sent,
    // so there is nothing for the server to be told about.
    const row = preset("Agent submission", "html");
    COMMANDS.deleteCompilePreset(db.adapter, { projectId, id: row.id });
    expect(queuedFor(row.id)).toBeUndefined();
  });

  it("queues a delete for a preset the server already has", () => {
    const row = preset("Agent submission", "html");
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.deleteCompilePreset(db.adapter, { projectId, id: row.id });
    expect(queuedFor(row.id)?.op).toBe("delete");
  });
});

describe("listing presets", () => {
  it("returns them by name, which is the only stable order the schema allows", () => {
    // `compile_preset` has no order_key, and two presets made in the same millisecond
    // tie on created_at and then sort by a random uuid — a picker that reshuffles
    // itself between renders. Alphabetical is stable and is what a name is for.
    preset("Contest entry", "md");
    preset("Agent submission", "html");
    expect(
      COMMANDS.listCompilePresets(db.adapter, { projectId }).map((row) => row.name),
    ).toEqual(["Agent submission", "Contest entry"]);
  });

  it("does not return another project's", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    preset("Agent submission", "html");
    expect(COMMANDS.listCompilePresets(db.adapter, { projectId: other })).toHaveLength(0);
  });
});
