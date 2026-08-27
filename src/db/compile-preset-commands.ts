import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";

/**
 * Compile presets — a saved export format and selection — written next to the database.
 *
 * A preset is the answer to "what does a submission of this book look like": the format
 * it goes out in and which parts of the binder are in it. Without one an author rebuilds
 * that by hand on every export, which is exactly the thing a manuscript submission is
 * least forgiving about.
 *
 * Three fields and no more, because three is what the pipeline actually reads. The table
 * also carries `include_query`, `title_page` and `front_matter`, and the compile worker
 * consumes none of them: it loads `included_binder_items` and nothing else. Offering an
 * interface for the rest would be promising an author their title page will be honoured
 * when it will be silently dropped. They stay null until something renders them.
 *
 * The payload is shaped by the server's `SyncEntitySpec`, which is stricter than the
 * local table in two ways:
 *
 * - `included_binder_items` is a Postgres `uuid[]`. It goes as a JSON **array of id
 *   strings** — every element is parsed with `UUID.fromString`, so a non-uuid fails the
 *   whole push rather than being skipped.
 * - `separator_rules` must be a JSON **object**. Locally it is NOT NULL DEFAULT '{}';
 *   sending a bare string or an array is refused as `invalid_request`.
 *
 * And one cross-field rule, `compile_preset_has_selection`, mirrored on both sides: a
 * preset needs `included_binder_items` or `include_query`. An empty array satisfies it
 * and is how "the whole manuscript" is written down — which is also how the worker reads
 * it, since it only filters when the list is non-empty.
 */

/** Mirrors the CHECK on `compile_preset.format`, and the server's `ExportFormat`. */
export const EXPORT_FORMATS = ["md", "html", "txt", "rtf", "docx", "odt", "epub", "pdf"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export interface CompilePresetRow {
  id: string;
  project_id: string;
  name: string;
  format: string;
  included_binder_items: string | null;
  include_query: string | null;
  separator_rules: string;
  title_page: string | null;
  front_matter: string | null;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCompilePresetInput {
  projectId: string;
  name: string;
  format: string;
  /** The binder items to export. Empty means the whole manuscript. */
  includedIds: string[];
}

export interface UpdateCompilePresetInput {
  projectId: string;
  id: string;
  name?: string;
  format?: string;
  /** Undefined leaves the selection alone; an empty array means the whole manuscript. */
  includedIds?: string[];
}

export interface CompilePresetRef {
  projectId: string;
  id: string;
}

const PRESET_COLUMNS = `id, project_id, name, format, included_binder_items, include_query,
  separator_rules, title_page, front_matter, deleted_at, version, created_at, updated_at`;

function now(): string {
  return new Date().toISOString();
}

function requirePreset(db: SqliteAdapter, projectId: string, id: string): CompilePresetRow {
  const row = db.query<CompilePresetRow>(
    `SELECT ${PRESET_COLUMNS} FROM compile_preset
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That preset is not in this project.");
  return row;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("A preset needs a name.");
  return trimmed;
}

/** Checked here rather than left to the CHECK constraint, which surfaces as raw SQL. */
function requireFormat(format: string): ExportFormat {
  if (!isExportFormat(format)) throw new Error(`${format} is not an export format.`);
  return format;
}

/**
 * The selection, as ids this project actually has.
 *
 * Unknown ids are dropped rather than kept. An id that names nothing is either a scene
 * deleted on another device or a typo, and keeping it would mean a preset whose stated
 * contents and real contents differ — plus a push the server rejects outright, since
 * every element has to parse as a uuid before the array is bound.
 */
function selectionIn(db: SqliteAdapter, projectId: string, ids: readonly string[]): string[] {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = db.query<{ id: string }>(
    `SELECT id FROM binder_item
      WHERE project_id = ? AND deleted_at IS NULL AND type IN ('folder', 'document')
        AND id IN (${wanted.map(() => "?").join(", ")});`,
    [projectId, ...wanted],
  );
  const live = new Set(rows.map((row) => row.id));
  // The author's order is kept: this is what a compile is assembled from.
  return wanted.filter((id) => live.has(id));
}

/**
 * Queues a preset as the whole row.
 *
 * `pending_change` holds one entry per entity and coalesces by replacing the payload, so
 * a partial payload would erase whatever an earlier edit had put there.
 */
function queuePreset(
  db: SqliteAdapter,
  row: CompilePresetRow,
  op: "create" | "update" | "delete",
): void {
  enqueueChange(db, {
    projectId: row.project_id,
    entityType: "compile_preset",
    entityId: row.id,
    op,
    payload:
      op === "delete"
        ? undefined
        : {
            id: row.id,
            project_id: row.project_id,
            name: row.name,
            format: row.format,
            // Parsed back into an array: the column is uuid[] on the server, and a JSON
            // string holding "[...]" would be one value that is not a uuid.
            included_binder_items: JSON.parse(row.included_binder_items ?? "[]") as unknown,
            separator_rules: JSON.parse(row.separator_rules) as unknown,
            deleted_at: row.deleted_at,
          },
    baseVersion: row.version,
  });
}

export const COMPILE_PRESET_COMMANDS = {
  createCompilePreset: (
    db: SqliteAdapter,
    input: CreateCompilePresetInput,
  ): CompilePresetRow => {
    const name = requireName(input.name);
    const format = requireFormat(input.format);
    const included = selectionIn(db, input.projectId, input.includedIds);

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO compile_preset
         (id, project_id, name, format, included_binder_items, separator_rules,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?);`,
      [id, input.projectId, name, format, JSON.stringify(included), stamp, stamp],
    );

    const row = requirePreset(db, input.projectId, id);
    queuePreset(db, row, "create");
    return row;
  },

  updateCompilePreset: (
    db: SqliteAdapter,
    input: UpdateCompilePresetInput,
  ): CompilePresetRow => {
    const existing = requirePreset(db, input.projectId, input.id);
    const name = input.name === undefined ? existing.name : requireName(input.name);
    const format = input.format === undefined ? existing.format : requireFormat(input.format);
    const included =
      input.includedIds === undefined
        ? (existing.included_binder_items ?? "[]")
        : JSON.stringify(selectionIn(db, input.projectId, input.includedIds));

    db.run(
      `UPDATE compile_preset
          SET name = ?, format = ?, included_binder_items = ?, updated_at = ?
        WHERE id = ?;`,
      [name, format, included, now(), input.id],
    );

    const row = requirePreset(db, input.projectId, input.id);
    queuePreset(db, row, "update");
    return row;
  },

  deleteCompilePreset: (db: SqliteAdapter, input: CompilePresetRef): { id: string } => {
    const row = requirePreset(db, input.projectId, input.id);
    const stamp = now();
    db.run("UPDATE compile_preset SET deleted_at = ?, updated_at = ? WHERE id = ?;", [
      stamp,
      stamp,
      input.id,
    ]);
    queuePreset(db, { ...row, deleted_at: stamp, updated_at: stamp }, "delete");
    return { id: input.id };
  },

  /**
   * Every live preset in the project, by name.
   *
   * By name and not by creation, because `compile_preset` is the one synced table with
   * no `order_key`: the schema gives presets no author-defined order, and two made in
   * the same millisecond tie on `created_at` and then fall back to a random uuid. A
   * picker whose entries move between renders is worse than an alphabetical one.
   */
  listCompilePresets: (db: SqliteAdapter, input: { projectId: string }): CompilePresetRow[] =>
    db.query<CompilePresetRow>(
      `SELECT ${PRESET_COLUMNS} FROM compile_preset
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY name, id;`,
      [input.projectId],
    ),
} satisfies Record<string, (db: SqliteAdapter, input: never) => unknown>;
