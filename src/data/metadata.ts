import type { DatabaseClient } from "@/db/client";
import type { Reader } from "@/data/projects";
import { isFieldType, type FieldType } from "@/db/metadata-commands";

/**
 * Custom metadata, read from the local replica.
 *
 * Fields are the questions an author decided to ask of their binder — "Age", "Eyes",
 * "First appears" — and values are one item's answers. Both sync, so a character sheet
 * set up on a desktop is the same character sheet on a phone.
 *
 * Values are read per item rather than for the whole project. A cast of forty with a
 * dozen fields is five hundred rows, and only one item's worth is ever on screen.
 */

export type { FieldType };

export interface MetadataField {
  id: string;
  name: string;
  type: FieldType;
  /** The choices, for a select. Empty for every other kind. */
  options: string[];
}

/** One item's answers, by field id. A field with no answer is simply absent. */
export type MetadataValues = ReadonlyMap<string, unknown>;

export const NO_VALUES: MetadataValues = new Map();

interface FieldRow {
  id: string;
  name: string;
  field_type: string;
  options: string | null;
}

/**
 * Options that cannot be read are read as no options.
 *
 * A CHECK keeps malformed JSON out of the column, so what can actually arrive is JSON
 * of another shape, from a client that stored it differently. A select with no choices
 * renders as a select with nothing to pick, which is visibly wrong and recoverable —
 * where throwing would take the whole panel down over one field.
 */
function parseOptions(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((option): option is string => typeof option === "string")
      : [];
  } catch {
    return [];
  }
}

export async function loadMetadataFields(
  db: Reader,
  projectId: string,
): Promise<MetadataField[]> {
  const rows = await db.query<FieldRow>(
    `SELECT id, name, field_type, options FROM custom_metadata_field
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY order_key, id`,
    [projectId],
  );
  return rows
    // A kind this build does not know is dropped rather than guessed at. There is no
    // safe default: rendering an unknown type as text would offer an author an editor
    // that writes values the field's real type rejects.
    .filter((row) => isFieldType(row.field_type))
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.field_type as FieldType,
      options: parseOptions(row.options),
    }));
}

/**
 * One binder item's answers.
 *
 * Joined through `custom_metadata_field` rather than read straight from the value
 * table: a value whose field has been tombstoned is still on disk — deleting a field
 * deliberately leaves its answers alone — and it is not an answer to anything the
 * author can still see.
 */
export async function loadMetadataValues(
  db: Reader,
  projectId: string,
  binderItemId: string,
): Promise<MetadataValues> {
  const rows = await db.query<{ field_id: string; value: string | null }>(
    `SELECT v.field_id, v.value FROM custom_metadata_value v
       JOIN custom_metadata_field f ON f.id = v.field_id
      WHERE v.binder_item_id = ? AND f.project_id = ? AND f.deleted_at IS NULL`,
    [binderItemId, projectId],
  );

  const values = new Map<string, unknown>();
  for (const row of rows) {
    if (row.value === null) continue;
    try {
      values.set(row.field_id, JSON.parse(row.value));
    } catch {
      // Same reasoning as the options above: one unreadable answer is not a reason to
      // show none of them.
    }
  }
  return values;
}

// -- commands ----------------------------------------------------------------------

export const createMetadataField = (
  db: DatabaseClient,
  projectId: string,
  name: string,
  fieldType: string,
  options?: string[],
) =>
  db.command("createMetadataField", {
    projectId,
    name,
    fieldType,
    // Spread rather than passed as undefined: `exactOptionalPropertyTypes` treats an
    // explicit undefined as a different thing from an absent key, and the command
    // reads absence as "this field has no choices".
    ...(options === undefined ? {} : { options }),
  });

export const updateMetadataField = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  changes: { name?: string; options?: string[] },
) => db.command("updateMetadataField", { projectId, id, ...changes });

export const deleteMetadataField = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("deleteMetadataField", { projectId, id });

export const setMetadataValue = (
  db: DatabaseClient,
  projectId: string,
  binderItemId: string,
  fieldId: string,
  value: unknown,
) => db.command("setMetadataValue", { projectId, binderItemId, fieldId, value });
