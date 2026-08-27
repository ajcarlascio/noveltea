import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";
import { between } from "@/data/order";

/**
 * Custom metadata — author-defined fields, and their values per binder item.
 *
 * Two tables, and the split is the point. `custom_metadata_field` is the *shape*: a
 * name, a type and, for a select, its options, defined once for the project.
 * `custom_metadata_value` is one answer, for one item, to one field. That is what a
 * character sheet is — "Age", "Eyes", "First appears" asked of every character — and
 * having it in the schema is the reason the app does not need a second system for
 * character sheets, location notes, or whatever else an author decides to track.
 *
 * The two tables behave very differently, and both differences come from the schema:
 *
 * - A **field** has `deleted_at`, so removing one is a tombstone.
 * - A **value** does not, on either side. Clearing one is a hard `DELETE`, and the
 *   delete in the change feed is the whole story — there is no tombstone left to tell
 *   a device that has never seen the row, and none is needed.
 *
 * `custom_metadata_value` also has no `project_id`; the server scopes it through its
 * binder item. Both `binder_item_id` and `field_id` are `parentRefs` it requires on
 * create and checks belong to the same project, so omitting either is an
 * `invalid_request` rather than a default.
 */

function now(): string {
  return new Date().toISOString();
}

/** Mirrors the CHECK on `custom_metadata_field.field_type`, and `MetadataFieldType`. */
export const FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

export interface MetadataFieldRow {
  id: string;
  project_id: string;
  name: string;
  field_type: string;
  options: string | null;
  order_key: string;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MetadataValueRow {
  id: string;
  binder_item_id: string;
  field_id: string;
  value: string | null;
  version: number;
}

export interface CreateFieldInput {
  projectId: string;
  name: string;
  fieldType: string;
  /** Only for a select, and required there. */
  options?: string[];
}

export interface UpdateFieldInput {
  projectId: string;
  id: string;
  name?: string;
  options?: string[];
}

export interface FieldRef {
  projectId: string;
  id: string;
}

export interface SetValueInput {
  projectId: string;
  binderItemId: string;
  fieldId: string;
  /** Null clears it, which deletes the row. */
  value: unknown;
}

const FIELD_COLUMNS = `id, project_id, name, field_type, options, order_key,
  deleted_at, version, created_at, updated_at`;

function requireField(db: SqliteAdapter, projectId: string, id: string): MetadataFieldRow {
  const row = db.query<MetadataFieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM custom_metadata_field
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That field is not in this project.");
  return row;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("A field needs a name.");
  return trimmed;
}

/**
 * The choices a select offers.
 *
 * Trimmed, emptied and deduplicated, because each of those produces a control an author
 * cannot use: a blank option is indistinguishable from "not set", and two identical ones
 * mean a value that cannot be told apart from itself.
 */
function requireOptions(options: readonly string[] | undefined): string[] {
  const cleaned = [...new Set((options ?? []).map((option) => option.trim()))].filter(
    (option) => option.length > 0,
  );
  if (cleaned.length === 0) throw new Error("A list needs at least one choice.");
  return cleaned;
}

/**
 * Checks a value against its field, and returns it as JSON text.
 *
 * A trust boundary, not tidying. This value is written to disk and pushed to a server
 * that stores it opaquely, so nothing downstream will ever notice that a field declared
 * "number" is holding the word "soon" — the interface will simply render something it
 * did not expect, on some other device, months later.
 */
function encodeValue(field: MetadataFieldRow, value: unknown): string {
  const wrong = (expected: string) =>
    new Error(`"${field.name}" takes ${expected}.`);

  switch (field.field_type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw wrong("a number");
      break;
    case "boolean":
      if (typeof value !== "boolean") throw wrong("yes or no");
      break;
    case "date":
      // A calendar date, not an instant: "first appears" is a day, and storing a
      // timezone-bearing timestamp would make the same date read differently abroad.
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw wrong("a date");
      }
      break;
    case "select": {
      const options = JSON.parse(field.options ?? "[]") as unknown;
      if (typeof value !== "string" || !(Array.isArray(options) && options.includes(value))) {
        throw wrong("one of its choices");
      }
      break;
    }
    default:
      if (typeof value !== "string") throw wrong("text");
  }
  return JSON.stringify(value);
}

/** The order key for a new last field in this project. */
function keyAtEnd(db: SqliteAdapter, projectId: string): string {
  const last = db.query<{ order_key: string }>(
    `SELECT order_key FROM custom_metadata_field
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY order_key DESC LIMIT 1;`,
    [projectId],
  )[0];
  return between(last?.order_key ?? null, null);
}

/**
 * Queues a field as the whole row.
 *
 * `options` goes as a parsed array or is omitted entirely. A JSON null would be
 * `hasNonNull` on the server for anything but a select and trip its
 * `custom_metadata_field_options_for_select` invariant — the mirror of the CHECK of the
 * same name — which fails the whole push rather than one row.
 */
function queueField(
  db: SqliteAdapter,
  row: MetadataFieldRow,
  op: "create" | "update" | "delete",
): void {
  enqueueChange(db, {
    projectId: row.project_id,
    entityType: "custom_metadata_field",
    entityId: row.id,
    op,
    payload:
      op === "delete"
        ? undefined
        : {
            id: row.id,
            project_id: row.project_id,
            name: row.name,
            field_type: row.field_type,
            ...(row.options === null ? {} : { options: JSON.parse(row.options) as unknown }),
            order_key: row.order_key,
            deleted_at: row.deleted_at,
          },
    baseVersion: row.version,
  });
}

function queueValue(
  db: SqliteAdapter,
  projectId: string,
  row: MetadataValueRow,
  op: "create" | "update" | "delete",
): void {
  enqueueChange(db, {
    projectId,
    entityType: "custom_metadata_value",
    entityId: row.id,
    op,
    payload:
      op === "delete"
        ? undefined
        : {
            id: row.id,
            // Both are parentRefs the server requires on create and checks belong to
            // this project. The table carries no project_id of its own.
            binder_item_id: row.binder_item_id,
            field_id: row.field_id,
            // Parsed back out of storage: the column is jsonb on the server, and the
            // text "\"blue\"" is a JSON string containing quotes, not the word blue.
            value: row.value === null ? null : (JSON.parse(row.value) as unknown),
          },
    baseVersion: row.version,
  });
}

export const METADATA_COMMANDS = {
  createMetadataField: (db: SqliteAdapter, input: CreateFieldInput): MetadataFieldRow => {
    const name = requireName(input.name);
    if (!isFieldType(input.fieldType)) {
      throw new Error(`${input.fieldType} is not a kind of field.`);
    }
    // Mirrors the server's invariant rather than discovering it on the next push:
    // options belong to a select and to nothing else.
    const options = input.fieldType === "select" ? requireOptions(input.options) : null;

    // The unique index is partial — `WHERE deleted_at IS NULL` — so a name freed by a
    // deletion is available again. Checked here so the collision is a sentence rather
    // than a constraint failure.
    const taken = db.query<{ id: string }>(
      `SELECT id FROM custom_metadata_field
        WHERE project_id = ? AND name = ? AND deleted_at IS NULL;`,
      [input.projectId, name],
    )[0];
    if (taken) throw new Error(`This project already has a field called "${name}".`);

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO custom_metadata_field
         (id, project_id, name, field_type, options, order_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.projectId,
        name,
        input.fieldType,
        options === null ? null : JSON.stringify(options),
        keyAtEnd(db, input.projectId),
        stamp,
        stamp,
      ],
    );

    const row = requireField(db, input.projectId, id);
    queueField(db, row, "create");
    return row;
  },

  /**
   * Renames a field, or changes what a select offers.
   *
   * The *type* cannot change. Every value already stored was checked against the old
   * one, and there is no honest conversion: "yes" is not a number, and a date is not
   * one of a select's choices. Changing it would leave rows that pass no check and
   * render as nothing. A new field is the honest way to change your mind.
   */
  updateMetadataField: (db: SqliteAdapter, input: UpdateFieldInput): MetadataFieldRow => {
    const existing = requireField(db, input.projectId, input.id);
    if (input.options !== undefined && existing.field_type !== "select") {
      throw new Error(`"${existing.name}" is not a list, so it has no choices.`);
    }

    const name = input.name === undefined ? existing.name : requireName(input.name);
    if (name !== existing.name) {
      const taken = db.query<{ id: string }>(
        `SELECT id FROM custom_metadata_field
          WHERE project_id = ? AND name = ? AND deleted_at IS NULL AND id <> ?;`,
        [input.projectId, name, input.id],
      )[0];
      if (taken) throw new Error(`This project already has a field called "${name}".`);
    }

    const options =
      input.options === undefined
        ? existing.options
        : JSON.stringify(requireOptions(input.options));

    db.run(
      "UPDATE custom_metadata_field SET name = ?, options = ?, updated_at = ? WHERE id = ?;",
      [name, options, now(), input.id],
    );

    const row = requireField(db, input.projectId, input.id);
    queueField(db, row, "update");
    return row;
  },

  /**
   * Tombstones a field.
   *
   * Its values are left alone, deliberately. They become unreachable the moment the
   * field is gone — nothing lists a value whose field no one can name — and the
   * schema's cascade is on a hard delete, which a tombstone is not, on either side.
   * Deleting them would mean a queue entry per binder item that ever filled the field
   * in, so removing "Eyes" from a cast of forty would push forty deletes to say one
   * thing. If the field comes back from another device, so do its answers.
   */
  deleteMetadataField: (db: SqliteAdapter, input: FieldRef): { id: string } => {
    const row = requireField(db, input.projectId, input.id);
    const stamp = now();
    db.run("UPDATE custom_metadata_field SET deleted_at = ?, updated_at = ? WHERE id = ?;", [
      stamp,
      stamp,
      input.id,
    ]);
    queueField(db, { ...row, deleted_at: stamp, updated_at: stamp }, "delete");
    return { id: input.id };
  },

  /**
   * Sets one item's answer to one field, or clears it.
   *
   * Clearing deletes the row rather than storing a JSON null. The table has no
   * `deleted_at` on either side, so a delete is what the change feed carries anyway,
   * and a row holding null would be a stored answer meaning "no answer".
   */
  setMetadataValue: (db: SqliteAdapter, input: SetValueInput): { id: string | null } => {
    const field = requireField(db, input.projectId, input.fieldId);
    const item = db.query<{ id: string }>(
      `SELECT id FROM binder_item
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL
          AND type IN ('folder', 'document');`,
      [input.binderItemId, input.projectId],
    )[0];
    if (!item) throw new Error("That item is not in this project.");

    const existing = db.query<MetadataValueRow>(
      `SELECT id, binder_item_id, field_id, value, version FROM custom_metadata_value
        WHERE binder_item_id = ? AND field_id = ?;`,
      [input.binderItemId, input.fieldId],
    )[0];

    if (input.value === null) {
      if (!existing) return { id: null };
      db.run("DELETE FROM custom_metadata_value WHERE id = ?;", [existing.id]);
      queueValue(db, input.projectId, existing, "delete");
      return { id: null };
    }

    const encoded = encodeValue(field, input.value);
    const stamp = now();

    if (existing) {
      db.run("UPDATE custom_metadata_value SET value = ?, updated_at = ? WHERE id = ?;", [
        encoded,
        stamp,
        existing.id,
      ]);
      queueValue(db, input.projectId, { ...existing, value: encoded }, "update");
      return { id: existing.id };
    }

    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO custom_metadata_value
         (id, binder_item_id, field_id, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, input.binderItemId, input.fieldId, encoded, stamp, stamp],
    );
    const row = db.query<MetadataValueRow>(
      `SELECT id, binder_item_id, field_id, value, version FROM custom_metadata_value
        WHERE id = ?;`,
      [id],
    )[0]!;
    queueValue(db, input.projectId, row, "create");
    return { id };
  },

  /** Every live field in the project, in author order. */
  listMetadataFields: (db: SqliteAdapter, input: { projectId: string }): MetadataFieldRow[] =>
    db.query<MetadataFieldRow>(
      `SELECT ${FIELD_COLUMNS} FROM custom_metadata_field
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY order_key, id;`,
      [input.projectId],
    ),
} satisfies Record<string, (db: SqliteAdapter, input: never) => unknown>;
