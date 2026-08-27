import type { SqliteAdapter, SqlValue } from "@noveltea/client-db";
import { clearAccepted, enqueueChange, markAttempted, pendingChanges } from "@noveltea/client-db";
import { between } from "@/data/order";

/**
 * The database half of sync: applying a pull, and settling a push.
 *
 * These live in the worker with the binder commands, for the same reason. Applying a
 * page of changes and advancing the cursor must happen together — a cursor that moves
 * without its rows skips them permanently, and rows applied without the cursor moving
 * arrive twice.
 */

/** Which table each entity type lands in. Fixed here, never taken from a payload. */
const TABLES: Record<string, string> = {
  binder_item: "binder_item",
  document: "document",
  taxonomy: "taxonomy",
  snapshot: "snapshot",
  custom_metadata_field: "custom_metadata_field",
  custom_metadata_value: "custom_metadata_value",
  collection: "collection",
  collection_item: "collection_item",
  compile_preset: "compile_preset",
  comment: "comment",
};

export interface ChangeRecord {
  id: number;
  entityType: string;
  entityId: string;
  op: string;
  data: Record<string, unknown> | null;
}

export interface ApplyPullInput {
  projectId: string;
  changes: ChangeRecord[];
  /** Highest id actually served. Never the feed's maximum. */
  latestId: number;
  syncEpoch: number;
  /**
   * Whether this call owns the cursor. A rebuild applies rows that did not come from
   * the feed at all, and must not claim a position in it — leaving this true there
   * would reset the cursor to zero, and a failure before the caller corrected it
   * would ask the server for another rebuild on the next sync.
   */
  advanceCursor?: boolean;
  now?: string;
}

export interface ApplyPullResult {
  applied: number;
  /** Entity types this client's schema has no table for, reported once each. */
  skipped: string[];
}

/**
 * Columns a table actually has.
 *
 * Read from the schema rather than listed here, so a server that sends a field this
 * client's migrations have not caught up to is ignored instead of failing the whole
 * page — and so this file does not become a second copy of the schema that drifts.
 *
 * The table name is interpolated because PRAGMA takes no parameters. It comes from
 * TABLES above and never from a payload; nothing a server sends reaches this string.
 */
function columnsOf(db: SqliteAdapter, table: string): Set<string> {
  const rows = db.query<{ name: string }>(`PRAGMA table_info(${table});`);
  return new Set(rows.map((row) => row.name));
}

/** SQLite has no JSON type: objects and arrays are stored as text. */
function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

function isSiblingOrderCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:.*order_key/.test(message);
}

/**
 * Moves a local binder item off an order key an incoming row needs.
 *
 * The displaced row is re-queued with its new key, so the server hears about the move
 * rather than the two devices disagreeing about order forever.
 */
function displaceLocalSibling(
  db: SqliteAdapter,
  projectId: string,
  incomingId: string,
  data: Record<string, unknown>,
  now: string,
): void {
  const parentId = typeof data.parent_id === "string" ? data.parent_id : null;
  const orderKey = typeof data.order_key === "string" ? data.order_key : null;
  if (orderKey === null) return;

  const holder = db.query<{ id: string; version: number }>(
    `SELECT id, version FROM binder_item
      WHERE project_id = ? AND order_key = ? AND id <> ?
        AND parent_id IS ${parentId === null ? "NULL" : "?"};`,
    parentId === null ? [projectId, orderKey, incomingId] : [projectId, orderKey, incomingId, parentId],
  )[0];
  if (!holder) return;

  const last = db.query<{ order_key: string }>(
    `SELECT order_key FROM binder_item
      WHERE project_id = ? AND deleted_at IS NULL
        AND parent_id IS ${parentId === null ? "NULL" : "?"}
      ORDER BY order_key DESC LIMIT 1;`,
    parentId === null ? [projectId] : [projectId, parentId],
  )[0];

  const moved = between(last?.order_key ?? null, null);

  // A row the server has never acknowledged must stay a create. The normal trigger
  // for reaching this branch with such a row: its create push lost the order_key race
  // to another device and was rejected INVALID_REQUEST, and the client cleared that
  // pending row. Enqueueing an update here comes back ENTITY_MISSING — also cleared —
  // and the item then exists only on this device until a resync erases it. Re-creating
  // with the fresh key is accepted and the item survives. Rows the server already has
  // keep the cheaper update path.
  const hasPending = db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_change WHERE entity_type = 'binder_item' AND entity_id = ?;",
    [holder.id],
  )[0];
  const neverAcknowledged = holder.version === 1 || (hasPending?.n ?? 0) > 0;

  if (neverAcknowledged) {
    const full = db.query<{ title: string; type: string }>(
      "SELECT title, type FROM binder_item WHERE id = ?;",
      [holder.id],
    )[0];
    db.run("UPDATE binder_item SET order_key = ?, updated_at = ? WHERE id = ?;", [
      moved,
      now,
      holder.id,
    ]);
    enqueueChange(db, {
      projectId,
      entityType: "binder_item",
      entityId: holder.id,
      op: "create",
      payload: {
        id: holder.id,
        type: full?.type ?? "document",
        title: full?.title ?? "",
        parent_id: parentId,
        order_key: moved,
        updated_at: now,
      },
      baseVersion: null,
    });
    return;
  }

  db.run("UPDATE binder_item SET order_key = ?, updated_at = ? WHERE id = ?;", [
    moved,
    now,
    holder.id,
  ]);

  enqueueChange(db, {
    projectId,
    entityType: "binder_item",
    entityId: holder.id,
    op: "update",
    payload: { id: holder.id, order_key: moved, updated_at: now },
    baseVersion: holder.version,
  });
}

export const SYNC_COMMANDS = {
  /**
   * Applies a page of changes and advances the cursor, together.
   *
   * Unknown entity types are skipped rather than failing the page: a newer server
   * may feed rows this client has no table for, and refusing the whole page would
   * stall sync permanently on a version difference.
   */
  applyPull: (db: SqliteAdapter, input: ApplyPullInput): ApplyPullResult => {
    const stamp = input.now ?? new Date().toISOString();
    const skipped = new Set<string>();
    let applied = 0;

    for (const change of input.changes) {
      const table = TABLES[change.entityType];
      if (table === undefined) {
        skipped.add(change.entityType);
        continue;
      }

      const columns = columnsOf(db, table);

      if (change.op === "delete") {
        if (columns.has("deleted_at")) {
          db.run(`UPDATE ${table} SET deleted_at = ? WHERE id = ?;`, [stamp, change.entityId]);
        } else {
          // No tombstone column: the row is only reachable through a parent that has
          // one, so removing it locally loses nothing another device still needs.
          db.run(`DELETE FROM ${table} WHERE id = ?;`, [change.entityId]);
        }
        applied += 1;
        continue;
      }

      const data = change.data ?? {};
      const names = Object.keys(data).filter((key) => columns.has(key));
      if (!names.includes("id")) names.push("id");

      const values = names.map((name) =>
        name === "id" ? change.entityId : toSqlValue(data[name]),
      );
      const placeholders = names.map(() => "?").join(", ");
      const updates = names
        .filter((name) => name !== "id")
        .map((name) => `${name} = excluded.${name}`)
        .join(", ");

      const upsert = () => {
        db.run(
          `INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders})
           ON CONFLICT(id) DO UPDATE SET ${updates.length > 0 ? updates : "id = excluded.id"};`,
          values,
        );
      };

      try {
        upsert();
      } catch (error) {
        // The one collision a pull can legitimately hit. Two devices, both offline,
        // both add a sibling after the same item: `between` is deterministic, so both
        // pick the same order_key. Whichever pushes first wins, and the other device
        // pulls a row whose key its own unpushed row is already holding.
        //
        // The server's ordering is the accepted one, so the *local* row moves. Failing
        // the page instead would stall sync until the author noticed and reordered
        // something by hand.
        if (!isSiblingOrderCollision(error)) throw error;
        displaceLocalSibling(db, input.projectId, change.entityId, data, stamp);
        upsert();
      }
      applied += 1;
    }

    if (input.advanceCursor === false) return { applied, skipped: [...skipped] };

    db.run(
      `INSERT INTO sync_state (project_id, last_change_id, sync_epoch, last_synced_at, last_error)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         last_change_id = excluded.last_change_id,
         sync_epoch = excluded.sync_epoch,
         last_synced_at = excluded.last_synced_at,
         last_error = NULL;`,
      [input.projectId, input.latestId, input.syncEpoch, stamp],
    );

    return { applied, skipped: [...skipped] };
  },

  /** The cursor and epoch a pull should resume from. */
  syncState: (
    db: SqliteAdapter,
    input: { projectId: string },
  ): { lastChangeId: number; syncEpoch: number; lastSyncedAt: string | null; lastError: string | null; pending: number } => {
    const row = db.query<{
      last_change_id: number;
      sync_epoch: number;
      last_synced_at: string | null;
      last_error: string | null;
    }>(
      "SELECT last_change_id, sync_epoch, last_synced_at, last_error FROM sync_state WHERE project_id = ?;",
      [input.projectId],
    )[0];

    const pending = db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pending_change WHERE project_id = ?;",
      [input.projectId],
    )[0];

    return {
      lastChangeId: row?.last_change_id ?? 0,
      syncEpoch: row?.sync_epoch ?? 1,
      lastSyncedAt: row?.last_synced_at ?? null,
      lastError: row?.last_error ?? null,
      pending: pending?.n ?? 0,
    };
  },

  /**
   * Reads the queue and marks it in flight, in one step.
   *
   * `markAttempted` runs before the push, never after: if a push is applied and the
   * response is lost, an entry that was never marked can be dropped locally while the
   * server keeps the row — a deleted item that returns on the next pull as a ghost.
   */
  takePending: (
    db: SqliteAdapter,
    input: { projectId: string; limit?: number },
  ): { id: number; entityType: string; entityId: string; op: string; baseVersion: number | null; data: unknown }[] => {
    const rows = pendingChanges(db, input.projectId).slice(0, input.limit ?? 200);
    markAttempted(db, rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      op: row.op,
      baseVersion: row.base_version,
      data: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
    }));
  },

  /** Clears what the server accepted. Anything else stays queued for the next push. */
  settlePush: (db: SqliteAdapter, input: { ids: number[] }): { cleared: number } => {
    clearAccepted(db, input.ids);
    return { cleared: input.ids.length };
  },

  /** Records why a sync attempt failed, without touching the cursor. */
  recordSyncFailure: (
    db: SqliteAdapter,
    input: { projectId: string; error: string; now?: string },
  ): void => {
    const stamp = input.now ?? new Date().toISOString();
    db.run(
      `INSERT INTO sync_state (project_id, last_attempt_at, last_error)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
                                             last_error = excluded.last_error;`,
      [input.projectId, stamp, input.error],
    );
  },

  /**
   * Tombstones binder items the server did not list during a rebuild.
   *
   * A rebuild that only upserts leaves ghosts: an item deleted on the server while
   * this client was away, whose delete row retention has since purged, would linger
   * locally forever with nothing left to say it is gone.
   *
   * Items with a pending change are left alone. Those are local edits the server has
   * never seen — it cannot have listed them, and their absence says nothing about
   * whether the author still wants them.
   */
  pruneMissing: (
    db: SqliteAdapter,
    input: { projectId: string; keepIds: string[]; now?: string },
  ): { removed: number } => {
    const stamp = input.now ?? new Date().toISOString();
    const keep = new Set(input.keepIds);

    const rows = db.query<{ id: string; type: string }>(
      "SELECT id, type FROM binder_item WHERE project_id = ? AND deleted_at IS NULL;",
      [input.projectId],
    );
    const pending = new Set(
      db
        .query<{ entity_id: string }>(
          "SELECT entity_id FROM pending_change WHERE project_id = ?;",
          [input.projectId],
        )
        .map((row) => row.entity_id),
    );

    let removed = 0;
    for (const row of rows) {
      // The trash node is structural, not content: the server does not list it in the
      // binder, and removing it would leave the project with nowhere to trash things.
      if (row.type === "trash") continue;
      if (keep.has(row.id) || pending.has(row.id)) continue;
      db.run("UPDATE binder_item SET deleted_at = ?, updated_at = ? WHERE id = ?;", [
        stamp,
        stamp,
        row.id,
      ]);
      removed += 1;
    }
    return { removed };
  },

  /**
   * Throws away this project's replica so it can be rebuilt.
   *
   * Used when the server says the cursor points into history it cannot explain. The
   * pending queue is deliberately kept: those are local edits the server has not seen,
   * and discarding them would lose writing that never left the device.
   */
  resetForResync: (db: SqliteAdapter, input: { projectId: string }): void => {
    // binder_item cascades to document, snapshot, metadata values and comments.
    db.run("DELETE FROM binder_item WHERE project_id = ?;", [input.projectId]);
    for (const table of ["taxonomy", "custom_metadata_field", "collection", "compile_preset"]) {
      db.run(`DELETE FROM ${table} WHERE project_id = ?;`, [input.projectId]);
    }
    db.run(
      `INSERT INTO sync_state (project_id, last_change_id, last_error)
       VALUES (?, 0, NULL)
       ON CONFLICT(project_id) DO UPDATE SET last_change_id = 0, last_error = NULL;`,
      [input.projectId],
    );
  },
} satisfies Record<string, (db: SqliteAdapter, input: never) => unknown>;
