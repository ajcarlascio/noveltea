// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { loadMetadataFields, loadMetadataValues } from "@/data/metadata";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;
let marlowe: string;

const reader = {
  query: <T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> =>
    Promise.resolve(db.adapter.query<T>(sql, params)),
};

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  marlowe = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Marlowe",
  }).id;
});

afterEach(() => db.close());

const field = (name: string, fieldType: string, options?: string[]) =>
  COMMANDS.createMetadataField(db.adapter, {
    projectId,
    name,
    fieldType,
    ...(options === undefined ? {} : { options }),
  });

const set = (fieldId: string, value: unknown) =>
  COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId: marlowe, fieldId, value });

describe("reading fields", () => {
  it("reads the name, the kind and a list's choices", async () => {
    field("Eyes", "select", ["Blue", "Grey"]);
    expect(await loadMetadataFields(reader, projectId)).toEqual([
      { id: expect.any(String) as string, name: "Eyes", type: "select", options: ["Blue", "Grey"] },
    ]);
  });

  it("drops a kind this build does not know rather than guessing at it", async () => {
    // From a newer client, through sync. There is no safe default: rendering an unknown
    // kind as text would offer an editor that writes values the real kind refuses, and
    // the author would only find out on the device that understands the field.
    const eyes = field("Eyes", "text");
    db.adapter.run("PRAGMA ignore_check_constraints = ON;");
    db.adapter.run("UPDATE custom_metadata_field SET field_type = 'colour' WHERE id = ?;", [
      eyes.id,
    ]);
    db.adapter.run("PRAGMA ignore_check_constraints = OFF;");

    expect(await loadMetadataFields(reader, projectId)).toHaveLength(0);
  });

  it("reads unreadable choices as no choices rather than failing the panel", async () => {
    const eyes = field("Eyes", "select", ["Blue"]);
    db.adapter.run("UPDATE custom_metadata_field SET options = '{}' WHERE id = ?;", [eyes.id]);

    const [loaded] = await loadMetadataFields(reader, projectId);
    expect(loaded?.options).toEqual([]);
    expect(loaded?.name).toBe("Eyes");
  });
});

describe("reading an item's answers", () => {
  it("reads each kind back as the type it was stored as", async () => {
    const age = field("Age", "number");
    const alive = field("Alive", "boolean");
    const born = field("Born", "date");
    set(age.id, 42);
    set(alive.id, false);
    set(born.id, "1939-05-01");

    const values = await loadMetadataValues(reader, projectId, marlowe);
    expect(values.get(age.id)).toBe(42);
    expect(values.get(alive.id)).toBe(false);
    expect(values.get(born.id)).toBe("1939-05-01");
  });

  it("leaves out answers to a field that has been deleted", async () => {
    // Deleting a field deliberately leaves its answers on disk — one tombstone rather
    // than a queue entry per item. They are not answers to anything the author can
    // still see, so the join through the field is what keeps them out of sight.
    const eyes = field("Eyes", "text");
    set(eyes.id, "Grey");
    COMMANDS.deleteMetadataField(db.adapter, { projectId, id: eyes.id });

    expect(await loadMetadataValues(reader, projectId, marlowe)).toEqual(new Map());
  });

  it("does not read another item's answers", async () => {
    const eyes = field("Eyes", "text");
    const other = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "document",
      title: "Vivian",
    }).id;
    set(eyes.id, "Grey");

    expect(await loadMetadataValues(reader, projectId, other)).toEqual(new Map());
  });
});
