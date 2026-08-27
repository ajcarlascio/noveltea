// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * Custom metadata, against the real schema.
 *
 * The payload assertions matter as much as the row ones. `custom_metadata_value` binds
 * `value` as jsonb and needs both of its parent ids on create, and
 * `custom_metadata_field` mirrors a CHECK — options belong to a select and nothing else
 * — as a server invariant that fails the whole push, not one row. A local write that
 * looks right and a payload the server refuses is a field the author can see and no
 * other device ever will.
 */

let db: TestDatabase;
let projectId: string;
let marlowe: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  marlowe = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Marlowe",
  }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const field = (name: string, fieldType: string, options?: string[]) =>
  COMMANDS.createMetadataField(db.adapter, {
    projectId,
    name,
    fieldType,
    ...(options === undefined ? {} : { options }),
  });

const set = (fieldId: string, value: unknown, binderItemId = marlowe) =>
  COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId, fieldId, value });

const queued = (entityType: string) =>
  db.adapter
    .query<PendingChange>("SELECT * FROM pending_change;")
    .filter((row) => row.entity_type === entityType);

const payloadOf = (entityType: string, entityId: string) =>
  JSON.parse(
    queued(entityType).find((row) => row.entity_id === entityId)?.payload ?? "null",
  ) as Record<string, unknown>;

const storedValue = (fieldId: string) =>
  db.adapter.query<{ value: string | null }>(
    "SELECT value FROM custom_metadata_value WHERE binder_item_id = ? AND field_id = ?;",
    [marlowe, fieldId],
  )[0];

describe("defining a field", () => {
  it("stores the name, the kind and a list's choices", () => {
    const eyes = field("Eyes", "select", ["Blue", "Grey"]);
    expect(eyes.field_type).toBe("select");
    expect(JSON.parse(eyes.options!)).toEqual(["Blue", "Grey"]);
  });

  it("leaves options null for every other kind", () => {
    // The CHECK constraint `custom_metadata_field_options_for_select` and the server
    // invariant of the same name both refuse options on anything but a select.
    expect(field("Age", "number").options).toBeNull();
  });

  it("refuses a blank name, and a kind that is not one", () => {
    expect(() => field("  ", "text")).toThrow(/needs a name/i);
    expect(() => field("Mood", "colour")).toThrow(/not a kind of field/i);
  });

  it("refuses a list with no choices to offer", () => {
    expect(() => field("Eyes", "select", ["  ", ""])).toThrow(/at least one choice/i);
  });

  it("trims and deduplicates the choices", () => {
    // A blank choice is indistinguishable from "not set", and two identical ones make a
    // value that cannot be told apart from itself.
    const eyes = field("Eyes", "select", [" Blue ", "Blue", "Grey", ""]);
    expect(JSON.parse(eyes.options!)).toEqual(["Blue", "Grey"]);
  });

  it("refuses a name the project is already using", () => {
    field("Age", "number");
    expect(() => field("Age", "text")).toThrow(/already has a field/i);
  });

  it("frees the name again when the field is deleted", () => {
    // The unique index is partial — WHERE deleted_at IS NULL — so this is the schema's
    // own behaviour rather than a rule invented here.
    const age = field("Age", "number");
    COMMANDS.deleteMetadataField(db.adapter, { projectId, id: age.id });
    expect(() => field("Age", "text")).not.toThrow();
  });
});

describe("what reaches the server", () => {
  it("sends a list's choices as an array, and omits them entirely otherwise", () => {
    const eyes = field("Eyes", "select", ["Blue"]);
    expect(payloadOf("custom_metadata_field", eyes.id).options).toEqual(["Blue"]);

    const age = field("Age", "number");
    // Omitted, not null: `hasNonNull` on the server would read a JSON null as options
    // being present and trip the invariant that they belong only to a select.
    expect("options" in payloadOf("custom_metadata_field", age.id)).toBe(false);
  });

  it("sends a value as JSON, not as the text it is stored in", () => {
    const eyes = field("Eyes", "text");
    const { id } = set(eyes.id, "Grey");

    expect(storedValue(eyes.id)?.value).toBe('"Grey"');
    // The column is jsonb on the server. The stored text is a JSON string *containing*
    // quotes; sending it raw would store the quotes as part of the answer.
    expect(payloadOf("custom_metadata_value", id!).value).toBe("Grey");
  });

  it("keeps a number a number and a yes a boolean", () => {
    const age = field("Age", "number");
    const alive = field("Alive", "boolean");
    const ageId = set(age.id, 42).id!;
    const aliveId = set(alive.id, false).id!;

    expect(payloadOf("custom_metadata_value", ageId).value).toBe(42);
    expect(payloadOf("custom_metadata_value", aliveId).value).toBe(false);
  });

  it("sends both parent ids, which the server requires on create", () => {
    const eyes = field("Eyes", "text");
    const { id } = set(eyes.id, "Grey");
    const payload = payloadOf("custom_metadata_value", id!);

    // custom_metadata_value has no project_id of its own; the server scopes it through
    // the binder item, and checks both refs belong to the same project.
    expect(payload.binder_item_id).toBe(marlowe);
    expect(payload.field_id).toBe(eyes.id);
  });

  it("queues the whole field row on an update, not the part that changed", () => {
    const eyes = field("Eyes", "select", ["Blue"]);
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.updateMetadataField(db.adapter, { projectId, id: eyes.id, name: "Eye colour" });
    const payload = payloadOf("custom_metadata_field", eyes.id);
    expect(payload.name).toBe("Eye colour");
    // pending_change coalesces by replacing the payload, so a partial one would erase
    // the choices an earlier edit put there.
    expect(payload.options).toEqual(["Blue"]);
    expect(payload.field_type).toBe("select");
  });
});

describe("answering a field", () => {
  it("refuses a value the field's kind cannot hold", () => {
    const age = field("Age", "number");
    const born = field("Born", "date");
    const alive = field("Alive", "boolean");
    const eyes = field("Eyes", "select", ["Blue"]);

    expect(() => set(age.id, "soon")).toThrow(/takes a number/i);
    expect(() => set(born.id, "one tuesday")).toThrow(/takes a date/i);
    expect(() => set(alive.id, "yes")).toThrow(/takes yes or no/i);
    expect(() => set(eyes.id, "Hazel")).toThrow(/one of its choices/i);
  });

  it("takes a calendar date and refuses an instant", () => {
    // A day, not a moment: "first appears" is a date, and a timezone-bearing timestamp
    // would read as a different day abroad.
    const born = field("Born", "date");
    expect(() => set(born.id, "1939-05-01")).not.toThrow();
    expect(() => set(born.id, "1939-05-01T00:00:00Z")).toThrow(/takes a date/i);
  });

  it("replaces an answer rather than adding a second one", () => {
    const eyes = field("Eyes", "text");
    const first = set(eyes.id, "Grey").id;
    const second = set(eyes.id, "Blue").id;

    expect(second).toBe(first);
    expect(storedValue(eyes.id)?.value).toBe('"Blue"');
  });

  it("deletes the row when the answer is cleared", () => {
    // The table has no deleted_at on either side, so a delete is what the feed carries
    // anyway; a row holding null would be a stored answer meaning "no answer".
    const eyes = field("Eyes", "text");
    const id = set(eyes.id, "Grey").id!;
    db.adapter.run("DELETE FROM pending_change;");

    set(eyes.id, null);
    expect(storedValue(eyes.id)).toBeUndefined();
    expect(queued("custom_metadata_value").find((row) => row.entity_id === id)?.op).toBe(
      "delete",
    );
  });

  it("clearing an answer that was never given does nothing at all", () => {
    const eyes = field("Eyes", "text");
    db.adapter.run("DELETE FROM pending_change;");
    expect(set(eyes.id, null)).toEqual({ id: null });
    expect(queued("custom_metadata_value")).toHaveLength(0);
  });

  it("refuses an item that is not in this project", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    const stranger = COMMANDS.createBinderItem(db.adapter, {
      projectId: other,
      parentId: null,
      type: "document",
      title: "Not mine",
    }).id;
    const eyes = field("Eyes", "text");

    expect(() => set(eyes.id, "Grey", stranger)).toThrow(/not in this project/i);
  });
});

describe("changing a field", () => {
  it("refuses choices on a field that is not a list", () => {
    const age = field("Age", "number");
    expect(() =>
      COMMANDS.updateMetadataField(db.adapter, { projectId, id: age.id, options: ["1"] }),
    ).toThrow(/not a list/i);
  });

  it("refuses a rename onto a name already in use", () => {
    field("Age", "number");
    const eyes = field("Eyes", "text");
    expect(() =>
      COMMANDS.updateMetadataField(db.adapter, { projectId, id: eyes.id, name: "Age" }),
    ).toThrow(/already has a field/i);
  });
});

describe("deleting a field", () => {
  it("tombstones it and stops listing it", () => {
    const eyes = field("Eyes", "text");
    COMMANDS.deleteMetadataField(db.adapter, { projectId, id: eyes.id });
    expect(COMMANDS.listMetadataFields(db.adapter, { projectId })).toHaveLength(0);
  });

  it("leaves the answers alone, and pushes one delete rather than one per item", () => {
    // The values become unreachable the moment the field is gone, and the schema's
    // cascade is on a hard delete, which a tombstone is not. Deleting them here would
    // mean a queue entry per binder item that ever filled the field in.
    const eyes = field("Eyes", "text");
    set(eyes.id, "Grey");
    db.adapter.run("DELETE FROM pending_change;");

    COMMANDS.deleteMetadataField(db.adapter, { projectId, id: eyes.id });
    expect(storedValue(eyes.id)?.value).toBe('"Grey"');
    expect(queued("custom_metadata_value")).toHaveLength(0);
    expect(queued("custom_metadata_field")).toHaveLength(1);
  });

  it("collapses with its own create when the server has never seen it", () => {
    const eyes = field("Eyes", "text");
    COMMANDS.deleteMetadataField(db.adapter, { projectId, id: eyes.id });
    expect(queued("custom_metadata_field")).toHaveLength(0);
  });
});

describe("listing fields", () => {
  it("returns them in the order they were made, not another project's", () => {
    const other = COMMANDS.createProject(db.adapter, { title: "Elsewhere" }).id;
    field("Age", "number");
    field("Eyes", "text");
    COMMANDS.createMetadataField(db.adapter, {
      projectId: other,
      name: "Theirs",
      fieldType: "text",
    });

    expect(
      COMMANDS.listMetadataFields(db.adapter, { projectId }).map((row) => row.name),
    ).toEqual(["Age", "Eyes"]);
  });
});
