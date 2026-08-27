import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";
import { queueItem, requireItem, type BinderItemRow } from "./binder-item";
import { between } from "@/data/order";

/**
 * Labels and statuses — the `taxonomy` table — written next to the database.
 *
 * Both kinds are one table because they are the same thing to the schema: a named,
 * ordered term belonging to a project, which a binder item may point at. What differs
 * is only what an author means by them, and that a colour is worth having on a label
 * ("Bob's POV", drawn as a dot beside the title) and meaningless on a status
 * ("First draft"), which is a word.
 *
 * Deleting a term tombstones it **and clears it off every item carrying it**, in the
 * same transaction. Leaving the reference behind would be a binder item pointing at a
 * row that no longer exists — a dangling foreign key the server's own schema would
 * refuse, and one that no reader on any other device could resolve into a name.
 */

function now(): string {
  return new Date().toISOString();
}

export type TaxonomyKind = "label" | "status";

export interface TaxonomyRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  color: string | null;
  order_key: string;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTaxonomyInput {
  projectId: string;
  kind: TaxonomyKind;
  name: string;
  /** Hex, and only meaningful on a label. Statuses store null. */
  color: string | null;
}

export interface UpdateTaxonomyInput {
  projectId: string;
  id: string;
  name: string;
  color: string | null;
}

export interface TaxonomyRef {
  projectId: string;
  id: string;
}

/**
 * Sets a binder item's label, its status, or both.
 *
 * `undefined` leaves a field alone; `null` clears it. Two separate fields on one
 * command because the push carries the whole binder item row either way, so
 * splitting them into two commands would only mean two queue entries for one gesture.
 */
export interface SetItemTaxonomyInput {
  projectId: string;
  id: string;
  labelId?: string | null;
  statusId?: string | null;
}

const TAXONOMY_COLUMNS =
  "id, project_id, kind, name, color, order_key, deleted_at, version, created_at, updated_at";

function requireTerm(db: SqliteAdapter, projectId: string, id: string): TaxonomyRow {
  const row = db.query<TaxonomyRow>(
    `SELECT ${TAXONOMY_COLUMNS} FROM taxonomy
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That label or status is not in this project.");
  return row;
}

/**
 * Refuses a name already in use for this kind.
 *
 * The schema has the same unique index, so this is not the only guard — it is the one
 * that produces a sentence an author can act on. Without it the constraint surfaces
 * as SQLite's own text, which names the index.
 */
function requireNameIsFree(
  db: SqliteAdapter,
  projectId: string,
  kind: string,
  name: string,
  exceptId?: string,
): void {
  const clash = db.query<{ id: string }>(
    `SELECT id FROM taxonomy
      WHERE project_id = ? AND kind = ? AND name = ? AND deleted_at IS NULL;`,
    [projectId, kind, name],
  )[0];
  if (clash && clash.id !== exceptId) {
    throw new Error(
      kind === "label" ? "There is already a label with that name." : "There is already a status with that name.",
    );
  }
}

/** The order key for a new last term of this kind. */
function keyAtEnd(db: SqliteAdapter, projectId: string, kind: string): string {
  const last = db.query<{ order_key: string }>(
    `SELECT order_key FROM taxonomy
      WHERE project_id = ? AND kind = ? AND deleted_at IS NULL
      ORDER BY order_key DESC LIMIT 1;`,
    [projectId, kind],
  )[0];
  return between(last?.order_key ?? null, null);
}

/**
 * Queues a term as the whole row, for the same reason every other entity here does:
 * `pending_change` holds one entry per entity and coalescing replaces the payload, so
 * a rename followed by a recolour would otherwise arrive as a recolour alone.
 */
function queueTerm(db: SqliteAdapter, row: TaxonomyRow, op: "create" | "update" | "delete"): void {
  enqueueChange(db, {
    projectId: row.project_id,
    entityType: "taxonomy",
    entityId: row.id,
    op,
    payload:
      op === "delete"
        ? undefined
        : {
            id: row.id,
            project_id: row.project_id,
            kind: row.kind,
            name: row.name,
            color: row.color,
            order_key: row.order_key,
            deleted_at: row.deleted_at,
            updated_at: row.updated_at,
          },
    baseVersion: row.version,
  });
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("A label or status needs a name.");
  return trimmed;
}

export const TAXONOMY_COMMANDS = {
  createTaxonomy: (db: SqliteAdapter, input: CreateTaxonomyInput): TaxonomyRow => {
    const name = requireName(input.name);
    requireNameIsFree(db, input.projectId, input.kind, name);

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO taxonomy (id, project_id, kind, name, color, order_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.projectId,
        input.kind,
        name,
        // A status has no colour to show, so it stores none rather than one nothing
        // will ever draw.
        input.kind === "label" ? input.color : null,
        keyAtEnd(db, input.projectId, input.kind),
        stamp,
        stamp,
      ],
    );

    const row = requireTerm(db, input.projectId, id);
    queueTerm(db, row, "create");
    return row;
  },

  updateTaxonomy: (db: SqliteAdapter, input: UpdateTaxonomyInput): TaxonomyRow => {
    const existing = requireTerm(db, input.projectId, input.id);
    const name = requireName(input.name);
    requireNameIsFree(db, input.projectId, existing.kind, name, existing.id);

    db.run("UPDATE taxonomy SET name = ?, color = ?, updated_at = ? WHERE id = ?;", [
      name,
      existing.kind === "label" ? input.color : null,
      now(),
      input.id,
    ]);

    const row = requireTerm(db, input.projectId, input.id);
    queueTerm(db, row, "update");
    return row;
  },

  /**
   * Tombstones a term and takes it off everything wearing it.
   *
   * Both halves, or neither: the items are updated in this same transaction, and each
   * gets its own queue entry so the other devices learn that those items are now
   * unlabelled rather than pointing at a row they will never resolve.
   */
  deleteTaxonomy: (db: SqliteAdapter, input: TaxonomyRef): { cleared: number } => {
    const term = requireTerm(db, input.projectId, input.id);
    const column = term.kind === "label" ? "label_id" : "status_id";
    const stamp = now();

    const wearing = db.query<{ id: string }>(
      `SELECT id FROM binder_item WHERE project_id = ? AND ${column} = ?;`,
      [input.projectId, input.id],
    );
    for (const item of wearing) {
      db.run(`UPDATE binder_item SET ${column} = NULL, updated_at = ? WHERE id = ?;`, [
        stamp,
        item.id,
      ]);
      queueItem(db, requireItem(db, input.projectId, item.id), "update");
    }

    db.run("UPDATE taxonomy SET deleted_at = ?, updated_at = ? WHERE id = ?;", [
      stamp,
      stamp,
      input.id,
    ]);
    queueTerm(db, { ...term, deleted_at: stamp, updated_at: stamp }, "delete");
    return { cleared: wearing.length };
  },

  setItemTaxonomy: (db: SqliteAdapter, input: SetItemTaxonomyInput): BinderItemRow => {
    const item = requireItem(db, input.projectId, input.id);
    if (item.deleted_at !== null) throw new Error("That item no longer exists.");

    const labelId = input.labelId === undefined ? item.label_id : input.labelId;
    const statusId = input.statusId === undefined ? item.status_id : input.statusId;
    // A term from another project would be a foreign key the server refuses, and a
    // name this author never wrote showing up on their chapter.
    if (labelId !== null) requireKind(db, input.projectId, labelId, "label");
    if (statusId !== null) requireKind(db, input.projectId, statusId, "status");

    db.run(
      "UPDATE binder_item SET label_id = ?, status_id = ?, updated_at = ? WHERE id = ?;",
      [labelId, statusId, now(), input.id],
    );

    const row = requireItem(db, input.projectId, input.id);
    queueItem(db, row, "update");
    return row;
  },

  /** Every live term in the project, labels and statuses together, in author order. */
  listTaxonomy: (db: SqliteAdapter, input: { projectId: string }): TaxonomyRow[] =>
    db.query<TaxonomyRow>(
      `SELECT ${TAXONOMY_COLUMNS} FROM taxonomy
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY kind, order_key, id;`,
      [input.projectId],
    ),
} satisfies Record<string, (db: SqliteAdapter, input: never) => unknown>;

function requireKind(
  db: SqliteAdapter,
  projectId: string,
  id: string,
  kind: TaxonomyKind,
): void {
  const term = requireTerm(db, projectId, id);
  if (term.kind !== kind) {
    throw new Error(kind === "label" ? "That is not a label." : "That is not a status.");
  }
}
