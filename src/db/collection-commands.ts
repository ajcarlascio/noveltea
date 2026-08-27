import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";
import { between } from "@/data/order";

/**
 * Collections — saved groupings of binder items — written next to the database.
 *
 * Two kinds, one table. A **static** collection is a list an author put things on by
 * hand, held in `collection_item`. A **smart** collection is a saved query, held in
 * `collection.query`, and has no rows of its own: its members are worked out at read
 * time from the replica. That is the whole difference, and the schema's
 * `collection_smart_has_query` CHECK is what stops a smart one existing without the
 * query that defines it.
 *
 * The payloads here are shaped by the server's `SyncEntitySpec`, which is stricter
 * than the local schema in two ways worth knowing:
 *
 * - `query` must be a JSON **object**. An array or a bare string is refused as
 *   `invalid_request`, not coerced.
 * - `collection_item` has no `deleted_at` anywhere, so removing a member is a hard
 *   delete on both sides. There is no tombstone to tell a third device; the delete in
 *   the change feed is the whole story.
 *
 * `collection_item` also has no `project_id` of its own — the server scopes it through
 * its collection — so every read here joins to `collection` rather than trusting an id.
 */

function now(): string {
  return new Date().toISOString();
}

/**
 * What a smart collection asks for.
 *
 * Every field is optional and they are combined with AND; within a list the values are
 * combined with OR. An empty query matches everything, which is the honest reading of
 * "no conditions" and is what a half-built collection shows while the author is still
 * choosing.
 *
 * Deliberately a small, closed shape rather than an expression tree. The server stores
 * it as opaque jsonb and never interprets it, so the only thing keeping two clients
 * agreeing about what a saved query means is that the shape stays simple enough to
 * implement twice.
 */
export interface CollectionQuery {
  /** Any of these labels. */
  labelIds?: string[];
  /** Any of these statuses. */
  statusIds?: string[];
  /** Full-text over title, synopsis, body and notes — the same index search uses. */
  text?: string;
  /** Folders, documents, or both when absent. */
  types?: ("folder" | "document")[];
}

export interface CollectionRow {
  id: string;
  project_id: string;
  name: string;
  query: string | null;
  is_smart: number;
  color: string | null;
  order_key: string;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCollectionInput {
  projectId: string;
  name: string;
  color: string | null;
  /** A query makes it smart; null makes it a hand-made list. */
  query: CollectionQuery | null;
}

export interface UpdateCollectionInput {
  projectId: string;
  id: string;
  name?: string;
  color?: string | null;
  /**
   * Replaces the saved query. Undefined leaves it alone; null would turn a smart
   * collection into a static one, which is refused — see `updateCollection`.
   */
  query?: CollectionQuery;
}

export interface CollectionRef {
  projectId: string;
  id: string;
}

export interface CollectionMemberInput {
  projectId: string;
  collectionId: string;
  binderItemId: string;
}

const COLLECTION_COLUMNS = `id, project_id, name, query, is_smart, color, order_key,
  deleted_at, version, created_at, updated_at`;

function requireCollection(db: SqliteAdapter, projectId: string, id: string): CollectionRow {
  const row = db.query<CollectionRow>(
    `SELECT ${COLLECTION_COLUMNS} FROM collection
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That collection is not in this project.");
  return row;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("A collection needs a name.");
  return trimmed;
}

/**
 * Strips a query down to the fields this build understands, and drops empty ones.
 *
 * Not defensive tidying: the value is round-tripped through a server that stores it
 * opaquely, so a key written by a newer client would come back here and be saved again
 * unchanged if it were not removed. Dropping it is the honest option — this build
 * cannot evaluate what it does not know, and keeping the key would mean showing an
 * author a collection whose stated conditions are not the ones being applied.
 */
export function normaliseQuery(query: CollectionQuery): CollectionQuery {
  const clean: CollectionQuery = {};
  const ids = (values: string[] | undefined) =>
    values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? [];

  const labelIds = ids(query.labelIds);
  if (labelIds.length > 0) clean.labelIds = labelIds;

  const statusIds = ids(query.statusIds);
  if (statusIds.length > 0) clean.statusIds = statusIds;

  const text = query.text?.trim() ?? "";
  if (text.length > 0) clean.text = text;

  const types = (query.types ?? []).filter(
    (type) => type === "folder" || type === "document",
  );
  // Both kinds is the same as no condition, and the shorter form is what another
  // client will find easier to agree with.
  if (types.length === 1) clean.types = types;

  return clean;
}

/** The order key for a new last collection in this project. */
function keyAtEnd(db: SqliteAdapter, projectId: string): string {
  const last = db.query<{ order_key: string }>(
    `SELECT order_key FROM collection
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY order_key DESC LIMIT 1;`,
    [projectId],
  )[0];
  return between(last?.order_key ?? null, null);
}

/**
 * Queues a collection as the whole row.
 *
 * The keys are the server spec's column names, not this table's every column: `version`
 * and the timestamps are the server's to assign. `is_smart` goes as a boolean because
 * the spec declares it BOOLEAN — SQLite's 0/1 would arrive as a number and be refused.
 */
function queueCollection(
  db: SqliteAdapter,
  row: CollectionRow,
  op: "create" | "update" | "delete",
): void {
  enqueueChange(db, {
    projectId: row.project_id,
    entityType: "collection",
    entityId: row.id,
    op,
    payload:
      op === "delete"
        ? undefined
        : {
            id: row.id,
            project_id: row.project_id,
            name: row.name,
            // Sent as an object or omitted entirely. A null would be stored as JSON
            // null on a smart collection and trip the server's own invariant.
            ...(row.query === null ? {} : { query: JSON.parse(row.query) as unknown }),
            is_smart: row.is_smart === 1,
            color: row.color,
            order_key: row.order_key,
            deleted_at: row.deleted_at,
          },
    baseVersion: row.version,
  });
}

interface CollectionItemRow {
  id: string;
  collection_id: string;
  binder_item_id: string;
  order_key: string;
  version: number;
}

function queueMember(
  db: SqliteAdapter,
  projectId: string,
  row: CollectionItemRow,
  op: "create" | "delete",
): void {
  enqueueChange(db, {
    projectId,
    entityType: "collection_item",
    entityId: row.id,
    op,
    payload:
      op === "delete"
        ? undefined
        : {
            id: row.id,
            // Both are `parentRefs` the server requires on create and checks belong to
            // the same project. Omitting either is an invalid_request, not a default.
            collection_id: row.collection_id,
            binder_item_id: row.binder_item_id,
            order_key: row.order_key,
          },
    baseVersion: row.version,
  });
}

export const COLLECTION_COMMANDS = {
  createCollection: (db: SqliteAdapter, input: CreateCollectionInput): CollectionRow => {
    const name = requireName(input.name);
    const query = input.query === null ? null : normaliseQuery(input.query);

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO collection
         (id, project_id, name, query, is_smart, color, order_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.projectId,
        name,
        query === null ? null : JSON.stringify(query),
        query === null ? 0 : 1,
        input.color,
        keyAtEnd(db, input.projectId),
        stamp,
        stamp,
      ],
    );

    const row = requireCollection(db, input.projectId, id);
    queueCollection(db, row, "create");
    return row;
  },

  /**
   * Renames, recolours, or rewrites the saved query.
   *
   * A smart collection cannot be turned into a static one here and a static one cannot
   * be turned smart. Both are possible in the schema, and both would be a trap: the
   * first silently discards the query that was the collection, and the second produces
   * a list whose hand-picked members stop being what it contains. Making a second
   * collection is the honest way to change your mind.
   */
  updateCollection: (db: SqliteAdapter, input: UpdateCollectionInput): CollectionRow => {
    const existing = requireCollection(db, input.projectId, input.id);
    if (input.query !== undefined && existing.is_smart === 0) {
      throw new Error("That collection is a list, not a saved search.");
    }

    const name = input.name === undefined ? existing.name : requireName(input.name);
    const color = input.color === undefined ? existing.color : input.color;
    const query =
      input.query === undefined ? existing.query : JSON.stringify(normaliseQuery(input.query));

    db.run(
      "UPDATE collection SET name = ?, color = ?, query = ?, updated_at = ? WHERE id = ?;",
      [name, color, query, now(), input.id],
    );

    const row = requireCollection(db, input.projectId, input.id);
    queueCollection(db, row, "update");
    return row;
  },

  /**
   * Tombstones a collection.
   *
   * Its `collection_item` rows are left alone deliberately. Locally the schema's
   * cascade is on a hard delete, which a tombstone is not; on the server the same is
   * true, and the rows become unreachable the moment their collection is gone. Deleting
   * them here would mean a queue entry per member for rows nothing will ever read
   * again — and a static collection of forty scenes would push forty deletes to say one
   * thing.
   */
  deleteCollection: (db: SqliteAdapter, input: CollectionRef): { id: string } => {
    const row = requireCollection(db, input.projectId, input.id);
    const stamp = now();
    db.run("UPDATE collection SET deleted_at = ?, updated_at = ? WHERE id = ?;", [
      stamp,
      stamp,
      input.id,
    ]);
    queueCollection(db, { ...row, deleted_at: stamp, updated_at: stamp }, "delete");
    return { id: input.id };
  },

  addToCollection: (db: SqliteAdapter, input: CollectionMemberInput): { id: string } => {
    const collection = requireCollection(db, input.projectId, input.collectionId);
    if (collection.is_smart === 1) {
      throw new Error("A saved search collects its own members.");
    }

    const item = db.query<{ id: string }>(
      `SELECT id FROM binder_item
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL
          AND type IN ('folder', 'document');`,
      [input.binderItemId, input.projectId],
    )[0];
    if (!item) throw new Error("That item is not in this project.");

    // Already on the list is success, not an error: an author who adds a scene twice
    // meant it to be there, and the unique index would otherwise surface as SQL.
    const existing = db.query<{ id: string }>(
      "SELECT id FROM collection_item WHERE collection_id = ? AND binder_item_id = ?;",
      [input.collectionId, input.binderItemId],
    )[0];
    if (existing) return { id: existing.id };

    const last = db.query<{ order_key: string }>(
      "SELECT order_key FROM collection_item WHERE collection_id = ? ORDER BY order_key DESC LIMIT 1;",
      [input.collectionId],
    )[0];

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO collection_item
         (id, collection_id, binder_item_id, order_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, input.collectionId, input.binderItemId, between(last?.order_key ?? null, null), stamp, stamp],
    );

    const row = db.query<CollectionItemRow>(
      "SELECT id, collection_id, binder_item_id, order_key, version FROM collection_item WHERE id = ?;",
      [id],
    )[0]!;
    queueMember(db, input.projectId, row, "create");
    return { id };
  },

  /**
   * Takes an item off a hand-made list.
   *
   * A hard delete, because `collection_item` has no `deleted_at` on either side. The
   * queue entry is what tells the other devices; there is no tombstone left behind to
   * tell a device that has never seen the row, and none is needed — it would only be
   * learning about a membership that no longer exists.
   */
  removeFromCollection: (db: SqliteAdapter, input: CollectionMemberInput): { removed: number } => {
    requireCollection(db, input.projectId, input.collectionId);
    const row = db.query<CollectionItemRow>(
      `SELECT id, collection_id, binder_item_id, order_key, version FROM collection_item
        WHERE collection_id = ? AND binder_item_id = ?;`,
      [input.collectionId, input.binderItemId],
    )[0];
    if (!row) return { removed: 0 };

    db.run("DELETE FROM collection_item WHERE id = ?;", [row.id]);
    queueMember(db, input.projectId, row, "delete");
    return { removed: 1 };
  },

  /** Every live collection in the project, in author order. */
  listCollections: (db: SqliteAdapter, input: { projectId: string }): CollectionRow[] =>
    db.query<CollectionRow>(
      `SELECT ${COLLECTION_COLUMNS} FROM collection
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY order_key, id;`,
      [input.projectId],
    ),
} satisfies Record<string, (db: SqliteAdapter, input: never) => unknown>;
