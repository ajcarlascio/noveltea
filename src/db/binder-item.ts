import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";

/**
 * The binder item row, and the one way it is queued for sync.
 *
 * Its own module because two command files write binder items: `commands.ts` for the
 * tree itself, and `taxonomy-commands.ts`, which has to clear a label off every item
 * carrying it when that label is deleted. Both queue the **whole row**, and this is
 * the only copy of what "the whole row" means — a second copy would drift, and the
 * symptom of that drift is a column silently missing from a push.
 */

export interface BinderItemRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  order_key: string;
  icon: string | null;
  label_id: string | null;
  status_id: string | null;
  trashed_from_parent_id: string | null;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export const ITEM_COLUMNS = `id, project_id, parent_id, type, title, order_key, icon, label_id,
  status_id, trashed_from_parent_id, deleted_at, version, created_at, updated_at`;

export function requireItem(db: SqliteAdapter, projectId: string, id: string): BinderItemRow {
  const row = db.query<BinderItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM binder_item WHERE id = ? AND project_id = ?;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That item is not in this project.");
  return row;
}

/** The payload the server will be sent for this row. */
export function payloadOf(row: BinderItemRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    type: row.type,
    title: row.title,
    order_key: row.order_key,
    icon: row.icon,
    label_id: row.label_id,
    status_id: row.status_id,
    trashed_from_parent_id: row.trashed_from_parent_id,
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
  };
}

export function queueItem(
  db: SqliteAdapter,
  row: BinderItemRow,
  op: "create" | "update" | "delete",
): void {
  enqueueChange(db, {
    projectId: row.project_id,
    entityType: "binder_item",
    entityId: row.id,
    op,
    payload: op === "delete" ? undefined : payloadOf(row),
    // The version this client last synced. Local edits deliberately do not bump
    // `version` — the server assigns it — so the current value is that number, and
    // enqueueChange keeps whichever base_version an existing pending row already had.
    baseVersion: row.version,
  });
}
