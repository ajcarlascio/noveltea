import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";
import { between } from "@/data/order";

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

/** The columns that name a taxonomy term. */
export type TagColumn = "label_id" | "status_id";
const TAG_COLUMNS: readonly TagColumn[] = ["label_id", "status_id"];

/**
 * The payload the server will be sent for this row — without its label and status.
 *
 * A pull drops a label or status this replica holds no row for (see `applyPull`), so a
 * NULL here can mean "removed" or "never arrived". Sent with every rename, the second
 * would read as the first and clear the tag on every device. They go only when the
 * author set them; see `queueItem`.
 */
export function payloadOf(row: BinderItemRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    type: row.type,
    title: row.title,
    order_key: row.order_key,
    icon: row.icon,
    trashed_from_parent_id: row.trashed_from_parent_id,
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
  };
}

/**
 * @param tags the tag columns the author changed in this edit. A tag set earlier and
 *   still waiting in the queue is carried over, since coalescing replaces the payload
 *   and a rename after a relabel would otherwise push the rename alone.
 */
export function queueItem(
  db: SqliteAdapter,
  row: BinderItemRow,
  op: "create" | "update" | "delete",
  tags: readonly TagColumn[] = [],
): void {
  const payload = payloadOf(row);
  const queued = db.query<{ payload: string | null }>(
    "SELECT payload FROM pending_change WHERE entity_type = 'binder_item' AND entity_id = ?;",
    [row.id],
  )[0]?.payload;
  const before = queued ? (JSON.parse(queued) as Record<string, unknown>) : {};
  for (const column of TAG_COLUMNS) {
    if (tags.includes(column) || column in before) payload[column] = row[column];
  }

  enqueueChange(db, {
    projectId: row.project_id,
    entityType: "binder_item",
    entityId: row.id,
    op,
    payload: op === "delete" ? undefined : payload,
    // The version this client last synced. Local edits deliberately do not bump
    // `version` — the server assigns it — so the current value is that number, and
    // enqueueChange keeps whichever base_version an existing pending row already had.
    baseVersion: row.version,
  });
}

/**
 * Gives a project a trash node and queues its creation.
 *
 * The server makes a trash node only through its own REST endpoint, never on the sync
 * path, so a push is the only way it learns of this one. Without it, anything trashed
 * here moves under a parent the server has never heard of and the push is refused.
 */
export function mintTrash(db: SqliteAdapter, projectId: string): void {
  const last = db.query<{ order_key: string }>(
    `SELECT order_key FROM binder_item
      WHERE project_id = ? AND parent_id IS NULL AND deleted_at IS NULL
      ORDER BY order_key DESC LIMIT 1;`,
    [projectId],
  )[0];
  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO binder_item (id, project_id, parent_id, type, title, order_key, created_at, updated_at)
     VALUES (?, ?, NULL, 'trash', 'Trash', ?, ?, ?);`,
    [id, projectId, between(last?.order_key ?? null, null), stamp, stamp],
  );
  queueItem(db, requireItem(db, projectId, id), "create");
  markTrashQueued(db, projectId);
}

/** Notes that this project's trash node has been queued for the server, once. */
export function markTrashQueued(db: SqliteAdapter, projectId: string): void {
  db.run(
    `INSERT INTO local_config (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT (key) DO NOTHING;`,
    [`trash_queued:${projectId}`, new Date().toISOString()],
  );
}
