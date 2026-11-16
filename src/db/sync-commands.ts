import type { SqliteAdapter, SqlValue } from "@noveltea/client-db";
import { clearAccepted, enqueueChange, markAttempted, pendingChanges } from "@noveltea/client-db";
import { between } from "@/data/order";
import { markTrashQueued, mintTrash, queueItem, requireItem } from "./binder-item";
import { queueValue, type MetadataValueRow } from "./metadata-commands";

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

/**
 * The rows of a project a rebuild may prune, per entity type: live ones, scoped through
 * whichever parent carries the project where the table has no project_id.
 *
 * The trash node is structural, not content: removing it would leave the project with
 * nowhere to trash things, and its absence from a listing means nothing — the server's
 * `/binder` does list it once it has one, but a project's node is only on the server if
 * this client pushed it (see `createProject`). Automatic snapshots never leave the
 * device, so the server's silence about them means nothing.
 */
const PRUNABLE: Record<string, string> = {
  binder_item:
    "SELECT id FROM binder_item WHERE project_id = ? AND deleted_at IS NULL AND type <> 'trash';",
  taxonomy: "SELECT id FROM taxonomy WHERE project_id = ? AND deleted_at IS NULL;",
  custom_metadata_field:
    "SELECT id FROM custom_metadata_field WHERE project_id = ? AND deleted_at IS NULL;",
  collection: "SELECT id FROM collection WHERE project_id = ? AND deleted_at IS NULL;",
  compile_preset: "SELECT id FROM compile_preset WHERE project_id = ? AND deleted_at IS NULL;",
  comment: "SELECT id FROM comment WHERE project_id = ? AND deleted_at IS NULL;",
  custom_metadata_value: `SELECT v.id FROM custom_metadata_value v
                            JOIN binder_item b ON b.id = v.binder_item_id WHERE b.project_id = ?;`,
  collection_item: `SELECT i.id FROM collection_item i
                      JOIN collection c ON c.id = i.collection_id WHERE c.project_id = ?;`,
  snapshot: `SELECT s.id FROM snapshot s
               JOIN binder_item b ON b.id = s.document_id
              WHERE b.project_id = ? AND s.is_automatic = 0;`,
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

/**
 * The natural keys a pulled row can collide on besides its id, per table. `live` keys are
 * partial indexes over rows that are not tombstoned.
 */
const UNIQUE_KEYS: Record<string, { columns: string[]; live: boolean }> = {
  taxonomy: { columns: ["project_id", "kind", "name"], live: true },
  custom_metadata_field: { columns: ["project_id", "name"], live: true },
  custom_metadata_value: { columns: ["binder_item_id", "field_id"], live: false },
  collection_item: { columns: ["collection_id", "binder_item_id"], live: false },
};

function hasRow(db: SqliteAdapter, table: string, id: string): boolean {
  return db.query(`SELECT 1 FROM ${table} WHERE id = ?;`, [id]).length > 0;
}

/** Puts the text a document's queue entry holds into the document's row. */
function restoreQueuedBody(db: SqliteAdapter, id: string): void {
  const raw = db.query<{ payload: string | null }>(
    "SELECT payload FROM pending_change WHERE entity_type = 'document' AND entity_id = ?;",
    [id],
  )[0]?.payload;
  if (raw === null || raw === undefined) return;
  const body = JSON.parse(raw) as Record<string, unknown>;
  db.run(
    "UPDATE document SET content = ?, search_text = ?, word_count = ?, synopsis = ?, notes = ? WHERE id = ?;",
    [
      JSON.stringify(body.content),
      toSqlValue(body.search_text),
      typeof body.word_count === "number" ? body.word_count : 0,
      toSqlValue(body.synopsis),
      toSqlValue(body.notes),
      id,
    ],
  );
}

function pendingFor(db: SqliteAdapter, type: string, id: string): { id: number; op: string } | undefined {
  return db.query<{ id: number; op: string }>(
    "SELECT id, op FROM pending_change WHERE entity_type = ? AND entity_id = ?;",
    [type, id],
  )[0];
}

/** The payload fields that name a label, status or field by id, whichever entity carries them. */
const REFERENCE_FIELDS = ["label_id", "status_id", "field_id", "parent_id", "trashed_from_parent_id"];

/**
 * Rewrites every local mention of one id as another: the columns that reference it, the
 * JSON queries that can name a label, status or field, and the references in every queued
 * payload.
 *
 * A queued payload is rewritten in the fields that hold a reference — the ones above, and
 * a collection's `query` object — and nowhere else. A document body is the author's text,
 * and an id found in it is theirs to keep.
 */
function repoint(db: SqliteAdapter, projectId: string, from: string, to: string): void {
  db.run("UPDATE binder_item SET label_id = ? WHERE label_id = ?;", [to, from]);
  db.run("UPDATE binder_item SET status_id = ? WHERE status_id = ?;", [to, from]);
  for (const [table, column] of [["collection", "query"], ["compile_preset", "include_query"]] as const) {
    db.run(
      `UPDATE ${table} SET ${column} = replace(${column}, ?, ?)
        WHERE project_id = ? AND instr(${column}, ?) > 0;`,
      [from, to, projectId, from],
    );
  }
  const queued = db.query<{ id: number; payload: string }>(
    "SELECT id, payload FROM pending_change WHERE project_id = ? AND instr(payload, ?) > 0;",
    [projectId, from],
  );
  for (const { id, payload } of queued) {
    const body = JSON.parse(payload) as Record<string, unknown>;
    for (const field of REFERENCE_FIELDS) if (body[field] === from) body[field] = to;
    if (body.query !== undefined) {
      body.query = JSON.parse(JSON.stringify(body.query).replaceAll(from, to)) as unknown;
    }
    db.run("UPDATE pending_change SET payload = ? WHERE id = ?;", [JSON.stringify(body), id]);
  }
}

/**
 * Folds a local metadata value into the server's value for the same item and field, in
 * two halves: the local row is taken out first, to free the (item, field) pair, and its
 * value is put onto the server's row once that row is in.
 *
 * The local value is unsynced writing, and data entities are last-write-wins on push, so
 * it is what the author's push would have made the value anyway: it is copied onto the
 * server's row and queued there. A pending clear, or no pending change, carries nothing.
 */
function takeValue(db: SqliteAdapter, localId: string): (projectId: string, serverId: string) => void {
  const pending = pendingFor(db, "custom_metadata_value", localId);
  const local = db.query<{ value: string | null }>(
    "SELECT value FROM custom_metadata_value WHERE id = ?;",
    [localId],
  )[0];
  db.run("DELETE FROM custom_metadata_value WHERE id = ?;", [localId]);
  if (pending !== undefined) db.run("DELETE FROM pending_change WHERE id = ?;", [pending.id]);

  return (projectId, serverId) => {
    if (pending === undefined || pending.op === "delete" || local === undefined) return;
    db.run("UPDATE custom_metadata_value SET value = ? WHERE id = ?;", [local.value, serverId]);
    const row = db.query<MetadataValueRow>("SELECT * FROM custom_metadata_value WHERE id = ?;", [serverId])[0];
    if (row) queueValue(db, projectId, row, "update");
  };
}

/**
 * Makes the server's trash node this project's, for a pulled one under another id.
 *
 * A project has one, and the server's is the one every device is told about. This device's
 * own holds nothing but the items trashed under it, which move to the server's once it is
 * in. It steps aside first (as a folder, under an order key no one else can hold) because
 * the one-per-project index would refuse the incoming node beside it, and is removed after
 * the items are repointed, so the cascade has nothing left to take.
 */
function adoptTrash(db: SqliteAdapter, projectId: string, incomingId: string): (() => void) | null {
  const mine = db.query<{ id: string }>(
    "SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash' AND id <> ?;",
    [projectId, incomingId],
  )[0];
  if (!mine) return null;

  db.run("UPDATE binder_item SET type = 'folder', order_key = id WHERE id = ?;", [mine.id]);
  return () => {
    for (const column of ["parent_id", "trashed_from_parent_id"]) {
      db.run(`UPDATE binder_item SET ${column} = ? WHERE ${column} = ?;`, [incomingId, mine.id]);
    }
    // Its own queue entry, if it had one, is a create of what the server already has.
    db.run("DELETE FROM pending_change WHERE entity_type = 'binder_item' AND entity_id = ?;", [mine.id]);
    db.run("DELETE FROM binder_item WHERE id = ?;", [mine.id]);
    repoint(db, projectId, mine.id, incomingId);
    // Two devices that each minted a trash node push both; the server refuses the second,
    // and with it everything that device trashed meanwhile (an unknown parent). Its pull
    // never brings those items back, so the move is sent again, under the server's node.
    const stranded = db.query<{ id: string }>(
      `SELECT id FROM binder_item
        WHERE project_id = ? AND parent_id = ? AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM pending_change p
                           WHERE p.entity_type = 'binder_item' AND p.entity_id = binder_item.id);`,
      [projectId, incomingId],
    );
    for (const { id } of stranded) queueItem(db, requireItem(db, projectId, id), "update");
  };
}

/**
 * Makes room for a pulled row whose natural key a different local row holds.
 *
 * The holder is one of three things, and each is resolved so that nothing the author
 * wrote is lost and both devices end on the server's row:
 *
 * - **No pending change.** A stale row: removed as a pulled delete would remove it,
 *   tombstoned where the table can be, so whatever still points at it stays valid. If
 *   the server still has it under another key, its own row brings it back.
 * - **A pending create** (any pending change, for values and collection items, which
 *   the server only ever has one of per key). The author made locally what the server
 *   already has: the server's row is adopted, every local reference and queued payload
 *   is pointed at it, and the redundant create is dropped. A local metadata value is
 *   copied onto the server's (see `takeValue`).
 * - **A pending edit or delete of a label, status or field the server knows.** Two
 *   server rows cannot be merged from here. A delete is taken as done; an edit keeps
 *   its row under a disambiguated name, queued, for the author to rename or merge.
 *
 * @returns what to run once the pulled row is in, or null when nothing held the key.
 */
function makeRoom(
  db: SqliteAdapter,
  projectId: string,
  table: string,
  incomingId: string,
  data: Record<string, unknown>,
  now: string,
): (() => void) | null {
  if (table === "binder_item" && data.type === "trash") return adoptTrash(db, projectId, incomingId);
  const key = UNIQUE_KEYS[table];
  if (key === undefined) return null;
  const holder = db.query<{ id: string }>(
    `SELECT id FROM ${table}
      WHERE ${key.columns.map((column) => `${column} = ?`).join(" AND ")} AND id <> ?
        ${key.live ? "AND deleted_at IS NULL" : ""};`,
    [...key.columns.map((column) => toSqlValue(data[column])), incomingId],
  )[0];
  if (!holder) return null;

  const noop = () => undefined;
  const pending = pendingFor(db, table, holder.id);
  const tombstone = () =>
    db.run(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?;`, [now, now, holder.id]);

  if (pending === undefined) {
    if (key.live) tombstone();
    else db.run(`DELETE FROM ${table} WHERE id = ?;`, [holder.id]);
    return noop;
  }

  if (table === "custom_metadata_value") {
    const give = takeValue(db, holder.id);
    return () => give(projectId, incomingId);
  }
  if (table === "collection_item") {
    db.run("DELETE FROM collection_item WHERE id = ?;", [holder.id]);
    db.run("DELETE FROM pending_change WHERE id = ?;", [pending.id]);
    return noop;
  }

  if (pending.op === "delete") {
    tombstone();
    return noop;
  }

  if (pending.op === "update") {
    const name = typeof data.name === "string" ? data.name : "";
    let suffix = 2;
    let aside = `${name} (${String(suffix)})`;
    const taken = (candidate: string) =>
      db.query(
        `SELECT 1 FROM ${table} WHERE ${key.columns.map((column) => `${column} = ?`).join(" AND ")}
           AND deleted_at IS NULL;`,
        key.columns.map((column) => (column === "name" ? candidate : toSqlValue(data[column]))),
      ).length > 0;
    while (taken(aside)) {
      suffix += 1;
      aside = `${name} (${String(suffix)})`;
    }
    db.run(`UPDATE ${table} SET name = ?, updated_at = ? WHERE id = ?;`, [aside, now, holder.id]);
    db.run("UPDATE pending_change SET payload = json_set(payload, '$.name', ?) WHERE id = ?;", [
      aside,
      pending.id,
    ]);
    return noop;
  }

  // A pending create of a label, status or field the server already has. The name is
  // freed first, and the row removed only once nothing points at it any more.
  tombstone();
  return () => {
    if (table === "custom_metadata_field") {
      const values = db.query<{ id: string; binder_item_id: string }>(
        "SELECT id, binder_item_id FROM custom_metadata_value WHERE field_id = ?;",
        [holder.id],
      );
      for (const value of values) {
        const twin = db.query<{ id: string }>(
          "SELECT id FROM custom_metadata_value WHERE binder_item_id = ? AND field_id = ?;",
          [value.binder_item_id, incomingId],
        )[0];
        if (twin) takeValue(db, value.id)(projectId, twin.id);
        else db.run("UPDATE custom_metadata_value SET field_id = ? WHERE id = ?;", [incomingId, value.id]);
      }
    }
    db.run("DELETE FROM pending_change WHERE id = ?;", [pending.id]);
    repoint(db, projectId, holder.id, incomingId);
    db.run(`DELETE FROM ${table} WHERE id = ?;`, [holder.id]);
  };
}

function isUniqueCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/.test(message);
}

/**
 * Whether this device took a manual snapshot and still holds its content, for a document
 * that is not tombstoned here. Rows pulled from the server never carry content, so one
 * that does was taken on this device; a snapshot of a deleted document is no one's draft.
 */
function ownSnapshot(db: SqliteAdapter, id: string): boolean {
  return (
    db.query(
      `SELECT 1 FROM snapshot s JOIN binder_item b ON b.id = s.document_id
        WHERE s.id = ? AND s.content IS NOT NULL AND b.deleted_at IS NULL;`,
      [id],
    ).length > 0
  );
}

/** Queues a manual snapshot as a create again, for a server that has lost it. */
function requeueSnapshot(db: SqliteAdapter, projectId: string, id: string): void {
  const row = db.query<{
    document_id: string;
    content: string;
    word_count: number;
    label: string | null;
    created_at: string;
  }>("SELECT document_id, content, word_count, label, created_at FROM snapshot WHERE id = ?;", [id])[0];
  if (!row) return;
  // The same payload captureSnapshot queues.
  enqueueChange(db, {
    projectId,
    entityType: "snapshot",
    entityId: id,
    op: "create",
    payload: {
      id,
      document_id: row.document_id,
      content: JSON.parse(row.content) as unknown,
      word_count: row.word_count,
      label: row.label,
      is_automatic: false,
      created_at: row.created_at,
    },
  });
}

/**
 * Every type `GET /sync/state` lists. A type the server listed nothing for still has to
 * be pruned, so this is fixed here rather than read from the rows.
 */
const STATE_TYPES = [
  "taxonomy",
  "custom_metadata_field",
  "collection",
  "compile_preset",
  "custom_metadata_value",
  "collection_item",
  "comment",
  "snapshot",
];

/** State rows that reference a binder item or a document, and so go in after them. */
const NEEDS_BINDER = new Set(["custom_metadata_value", "collection_item", "comment", "snapshot"]);

export interface RebuildRow {
  entityType: string;
  entityId: string;
  /** Null for a row the server listed but this client could not read: kept, not applied. */
  data: Record<string, unknown> | null;
}

export interface RebuildInput {
  projectId: string;
  /** The rows of `GET /sync/state`, or null from a server that does not have it. */
  state: RebuildRow[] | null;
  binder: RebuildRow[];
  documents: RebuildRow[];
  /** Where the feed resumes: the resync answer's latestId and epoch. */
  latestId: number;
  syncEpoch: number;
  /** The server was restored from a backup, so a manual snapshot it does not list is lost. */
  epochChanged?: boolean;
  now?: string;
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

      const queuedBody =
        table === "document" ? pendingFor(db, "document", change.entityId) : undefined;
      if (queuedBody !== undefined && hasRow(db, "document", change.entityId)) {
        // Unpushed writing outranks the server's copy here. Overwriting the row would
        // leave the author's text only in the queue, where the next keystroke in an
        // editor that reloaded the server's text replaces it for good. The push that
        // follows sends it against its old base version: if the server moved on, the
        // text becomes a conflict copy and the server re-feeds the original, which the
        // pull after it applies, the queue now being empty. Documents only: every other
        // type is last-write-wins on push, so the queued payload wins anyway.
        continue;
      }

      const data = { ...(change.data ?? {}) };
      if (table === "binder_item") {
        // A label or status this replica holds no row for cannot be referenced, and the
        // foreign key would fail the page. A rebuild brings taxonomy first, so this is
        // for what remains: the feed hydrates each row with the item's *current* state,
        // so an item's oldest row can name a label whose own row comes later in the
        // feed — and a server too old for `/sync/state` never sends it at all. The item
        // matters more than its tag; the tag returns with the later row that set it.
        for (const key of ["label_id", "status_id"]) {
          const ref = data[key];
          if (typeof ref !== "string") continue;
          if (db.query("SELECT 1 FROM taxonomy WHERE id = ?;", [ref]).length === 0) data[key] = null;
        }
      }
      if (table === "custom_metadata_value" && data.value !== null && data.value !== undefined) {
        // jsonb on the server, JSON text here. A text, date or select value arrives as a
        // bare string, which stored as-is is not JSON, fails the column's check, and
        // with it the page; a boolean would come back as 1.
        data.value = JSON.stringify(data.value);
      }
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
        if (isSiblingOrderCollision(error)) {
          displaceLocalSibling(db, input.projectId, change.entityId, data, stamp);
          upsert();
        } else {
          // The same for every other natural key: a label, a field name, an item's value
          // for a field, an item's place in a collection. Failing instead would fail
          // every sync, before the push, until the author found the row by hand.
          const then = isUniqueCollision(error)
            ? makeRoom(db, input.projectId, table, change.entityId, data, stamp)
            : null;
          if (then === null) throw error;
          upsert();
          then();
        }
      }
      // A queued body with no row of its own is one `settlePush` moved onto a conflict
      // copy this device has only now heard of. The server's row is the copy's first
      // version; the author's text is what the queue holds.
      if (queuedBody !== undefined) restoreQueuedBody(db, change.entityId);
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

  /**
   * Makes the project's trash node known to the server, once.
   *
   * Run after a pull, so a node the server has is already here and none is minted beside
   * it. A project with none gets one (an adopted project whose server never had one, or a
   * project the server has never been told the node of). A project with one that was
   * never queued, because it predates `mintTrash` queueing it, gets that create now; a
   * create for a node the server has is an update there, and harmless.
   */
  ensureTrash: (db: SqliteAdapter, input: { projectId: string }): void => {
    const row = db.query<{ id: string }>(
      "SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';",
      [input.projectId],
    )[0];
    if (!row) return mintTrash(db, input.projectId);
    const queued = db.query(
      "SELECT 1 FROM local_config WHERE key = ?;",
      [`trash_queued:${input.projectId}`],
    );
    if (queued.length > 0) return;
    queueItem(db, requireItem(db, input.projectId, row.id), "create");
    markTrashQueued(db, input.projectId);
  },

  /** The cursor and epoch a pull should resume from. */
  syncState: (
    db: SqliteAdapter,
    input: { projectId: string },
  ): { lastChangeId: number; syncEpoch: number; lastSyncedAt: string | null; lastError: string | null; pending: number; title: string; settings: string | null } => {
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

    const project = db.query<{ title: string; settings: string | null }>(
      "SELECT title, settings FROM project WHERE id = ?;",
      [input.projectId],
    )[0];

    return {
      lastChangeId: row?.last_change_id ?? 0,
      syncEpoch: row?.sync_epoch ?? 1,
      lastSyncedAt: row?.last_synced_at ?? null,
      lastError: row?.last_error ?? null,
      pending: pending?.n ?? 0,
      title: project?.title ?? "",
      settings: project?.settings ?? null,
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
  ): {
    id: number;
    entityType: string;
    entityId: string;
    op: string;
    baseVersion: number | null;
    data: unknown;
    /** The queued text as taken, so `settlePush` can tell whether it changed in flight. */
    payload: string | null;
  }[] => {
    // The trash node first: what is trashed names it as its parent, and the server refuses
    // a parent it has not heard of. Queue order alone would put a node minted by `ensureTrash`
    // behind the moves already waiting.
    const trash = db.query<{ id: string }>(
      "SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';",
      [input.projectId],
    )[0]?.id;
    const rows = pendingChanges(db, input.projectId)
      .sort((a, b) => Number(b.entity_id === trash) - Number(a.entity_id === trash))
      .slice(0, input.limit ?? 200);
    markAttempted(db, rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      op: row.op,
      baseVersion: row.base_version,
      data: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
      payload: row.payload,
    }));
  },

  /**
   * Clears what the server accepted. Anything else stays queued for the next push.
   *
   * The push is a network round trip, and the author keeps writing during it. An edit
   * made meanwhile merges into the very queue entry that was sent, so clearing that entry
   * by id would drop the newer text from the queue; the next pull of that document would
   * then overwrite it with nothing to say it was ever there. An entry whose payload is no
   * longer the one `sent` stays queued, rebased onto the version the server just gave the
   * write it builds on — a create the server now has goes on as an update.
   *
   * Each accepted row's local version moves to the server's too, so the next edit is
   * based on the write that was accepted and not the one before it, which the server
   * would take for a stale write: a conflict copy of the author's own text.
   *
   * A document edited in flight whose push became a conflict has no accepted version to
   * rebase on, and its old base is stale: the next push would conflict again and make a
   * second copy of nearly the same text. Basing it on the server's version instead would
   * overwrite text its author has never seen. The first copy holds the earlier text, so
   * the entry moves onto it — the copy is the document this author is writing now — and
   * the original, no longer queued, takes the server's text on the pull that follows.
   */
  settlePush: (
    db: SqliteAdapter,
    input: {
      ids: number[];
      sent?: { id: number; payload: string | null }[];
      applied?: { entityType: string; entityId: string; version: number }[];
      /** The conflict copies the server made, by the document each is a copy of. */
      copies?: { entityId: string; conflictCopyId: string }[];
    },
  ): { cleared: number } => {
    const versions = new Map<string, number>();
    for (const row of input.applied ?? []) {
      versions.set(`${row.entityType}:${row.entityId}`, row.version);
      const table = TABLES[row.entityType];
      if (table !== undefined) {
        db.run(`UPDATE ${table} SET version = MAX(version, ?) WHERE id = ?;`, [row.version, row.entityId]);
      }
    }

    const copies = new Map((input.copies ?? []).map((row) => [row.entityId, row.conflictCopyId]));
    const sent = new Map((input.sent ?? []).map((row) => [row.id, row.payload]));
    const cleared: number[] = [];
    for (const id of input.ids) {
      const now = db.query<{ entity_type: string; entity_id: string; payload: string | null }>(
        "SELECT entity_type, entity_id, payload FROM pending_change WHERE id = ?;",
        [id],
      )[0];
      if (now === undefined) continue;
      if (!sent.has(id) || sent.get(id) === now.payload) {
        cleared.push(id);
        continue;
      }
      const version = versions.get(`${now.entity_type}:${now.entity_id}`);
      const copy = now.entity_type === "document" ? copies.get(now.entity_id) : undefined;
      if (copy !== undefined) {
        // A copy is born at version 1.
        db.run(
          `UPDATE pending_change SET entity_id = ?, op = 'update', base_version = 1,
                                     payload = json_set(payload, '$.id', ?)
            WHERE id = ?;`,
          [copy, copy, id],
        );
        continue;
      }
      if (version === undefined) continue;
      db.run(
        `UPDATE pending_change SET base_version = ?, op = CASE op WHEN 'create' THEN 'update' ELSE op END
          WHERE id = ?;`,
        [version, id],
      );
    }
    clearAccepted(db, cleared);
    return { cleared: cleared.length };
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
   * Removes rows the server did not list during a rebuild.
   *
   * A rebuild that only upserts leaves ghosts: a row deleted on the server while this
   * client was away, whose delete row retention has since purged, would linger locally
   * forever with nothing left to say it is gone. Removed as a pulled delete would remove
   * it — tombstoned where the table has `deleted_at`, deleted where it has not.
   *
   * Only the types in `keep` are touched. A type the server could not list — anything
   * but the binder, on a server without `/sync/state` — says nothing by its absence.
   *
   * A manual snapshot that holds its content here is never removed: rows pulled from the
   * server never carry content, so one that does was taken on this device. Deleting it
   * would destroy a draft that may be the only copy. Whether the server's silence means
   * it lost the snapshot depends on why the rebuild happened, so the caller says:
   * `requeueSnapshots` after a restore from an older backup (the sync epoch changed),
   * which queues it as a create again. After an ordinary purge of the change log the
   * absence may be another device's delete, and re-creating it would undo that; it is
   * kept here, unsynced, which a snapshot tolerates — it is immutable, its restore reads
   * the local content, and a delete of it is accepted by a server that has none. A
   * snapshot of a document tombstoned here is neither kept nor queued.
   *
   * Rows with a pending change are left alone. Those are local edits the server has
   * never seen — it cannot have listed them, and their absence says nothing about
   * whether the author still wants them. Matched by id alone, so a binder item whose
   * document has unpushed writing is kept along with it.
   */
  pruneMissing: (
    db: SqliteAdapter,
    input: { projectId: string; keep: Record<string, string[]>; requeueSnapshots?: boolean; now?: string },
  ): { removed: number } => {
    const stamp = input.now ?? new Date().toISOString();
    const pending = new Set(
      db
        .query<{ entity_id: string }>(
          "SELECT entity_id FROM pending_change WHERE project_id = ?;",
          [input.projectId],
        )
        .map((row) => row.entity_id),
    );

    let removed = 0;
    for (const [type, ids] of Object.entries(input.keep)) {
      const rows = PRUNABLE[type];
      const table = TABLES[type];
      if (rows === undefined || table === undefined) continue;
      const keep = new Set(ids);
      const tombstone = columnsOf(db, table).has("deleted_at");

      for (const { id } of db.query<{ id: string }>(rows, [input.projectId])) {
        if (keep.has(id) || pending.has(id)) continue;
        if (type === "snapshot" && ownSnapshot(db, id)) {
          if (input.requeueSnapshots === true) requeueSnapshot(db, input.projectId, id);
          continue;
        }
        if (tombstone) {
          db.run(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?;`, [stamp, stamp, id]);
        } else {
          db.run(`DELETE FROM ${table} WHERE id = ?;`, [id]);
        }
        removed += 1;
      }
    }
    return { removed };
  },

  /**
   * Rebuilds a project from what the server listed, and moves the cursor, in one step.
   *
   * One command is one transaction (see `dispatch.ts`), and that is the point of this
   * one: everything has been fetched before it runs, so a failure or a closed tab at any
   * moment leaves the replica as it was or as the server has it, never pruned and not
   * yet restored.
   *
   * In this order:
   *
   * 1. Rows of the state types the server did not list are pruned, first, because the
   *    replica's unique indexes would otherwise refuse the server's row while a ghost
   *    still holds its place — a value cleared and set again on another device comes
   *    back under a new id for the same item and field.
   * 2. Labels, statuses, metadata fields, collections and presets, so the binder items
   *    that name them can.
   * 3. The tree, then every document body.
   * 4. Metadata values, collection items, comments and manual snapshots, now that what
   *    they hang on is here.
   * 5. Binder items the server did not list are pruned — otherwise an item deleted while
   *    this client was away, whose delete row retention has since purged, would linger
   *    forever with nothing left to say it is gone.
   * 6. The cursor, at the resync answer's latestId: pulling from 0 would land below the
   *    purge point again and ask for a resync forever.
   *
   * With no state (an older server) those types are neither restored nor pruned.
   */
  rebuildProject: (db: SqliteAdapter, input: RebuildInput): void => {
    const { projectId, state } = input;
    const now = input.now ?? new Date().toISOString();
    const apply = (rows: RebuildRow[]) => {
      const changes = rows.flatMap((row, index) =>
        row.data === null ? [] : [{ id: index, op: "update", ...row, data: row.data }],
      );
      if (changes.length === 0) return;
      SYNC_COMMANDS.applyPull(db, { projectId, changes, latestId: 0, syncEpoch: 0, advanceCursor: false, now });
    };
    const stateRows = (needsBinder: boolean) =>
      (state ?? []).filter((row) => NEEDS_BINDER.has(row.entityType) === needsBinder);

    if (state !== null) {
      const keep: Record<string, string[]> = Object.fromEntries(STATE_TYPES.map((type) => [type, []]));
      for (const row of state) keep[row.entityType]?.push(row.entityId);
      SYNC_COMMANDS.pruneMissing(db, { projectId, keep, requeueSnapshots: input.epochChanged === true, now });
    }
    apply(stateRows(false));
    apply(input.binder);
    apply(input.documents);
    apply(stateRows(true));
    SYNC_COMMANDS.pruneMissing(db, {
      projectId,
      keep: {
        binder_item: [...input.binder, ...input.documents].map((row) => row.entityId),
      },
      now,
    });
    SYNC_COMMANDS.applyPull(db, {
      projectId,
      changes: [],
      latestId: input.latestId,
      syncEpoch: input.syncEpoch,
      now,
    });
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
