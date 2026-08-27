import type { SqlValue } from "@noveltea/client-db";
import type { DatabaseClient } from "@/db/client";
import type { Reader } from "@/data/projects";
import type { CollectionQuery } from "@/db/collection-commands";
import { toFtsQuery } from "@/data/search";

/**
 * Collections, read from the local replica.
 *
 * A **saved** collection is a list of binder items an author put together by hand. A
 * **smart** collection is a saved query — "every scene Marlowe appears in" — evaluated
 * here, against the replica, every time it is opened. Neither touches the network: the
 * query is stored as jsonb and synced, but the *answering* of it is local, which is the
 * only way a saved search can work on a train.
 *
 * A smart collection is therefore never stale and never needs refreshing. It also has
 * no membership rows to conflict, which is why the two kinds cannot be converted into
 * one another.
 */

export type { CollectionQuery };

export interface Collection {
  id: string;
  name: string;
  color: string | null;
  /** Null for a hand-made list. */
  query: CollectionQuery | null;
  isSmart: boolean;
}

export interface CollectionMember {
  id: string;
  title: string;
  type: "folder" | "document";
  labelId: string | null;
  statusId: string | null;
}

interface CollectionRow {
  id: string;
  name: string;
  color: string | null;
  query: string | null;
  is_smart: number;
}

/**
 * A stored query that cannot be parsed reads as no conditions at all.
 *
 * The column is `json_valid`-checked locally and jsonb on the server, so this should
 * not happen — but the alternative to a fallback is a collection that throws when
 * opened, and an author whose binder will not render because one saved search is
 * malformed has lost far more than one search.
 */
function parseQuery(raw: string | null): CollectionQuery | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export async function loadCollections(db: Reader, projectId: string): Promise<Collection[]> {
  const rows = await db.query<CollectionRow>(
    `SELECT id, name, color, query, is_smart FROM collection
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY order_key, id`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    query: parseQuery(row.query),
    isSmart: row.is_smart === 1,
  }));
}

/**
 * Builds the WHERE fragments for a smart collection's conditions.
 *
 * Exported for its own test. The parts that are worth pinning without a database are
 * that an empty condition contributes nothing (rather than `IN ()`, which is a syntax
 * error), and that a text condition which tokenises to nothing means *no results*
 * rather than every result — the same rule search follows, and the one that would
 * otherwise turn a typo into "your whole manuscript".
 */
export function queryConditions(query: CollectionQuery): {
  clauses: string[];
  params: SqlValue[];
  /** True when the query names a text search that cannot be run. */
  impossible: boolean;
} {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  const inList = (column: string, values: string[] | undefined) => {
    if (values === undefined || values.length === 0) return;
    clauses.push(`b.${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };

  inList("label_id", query.labelIds);
  inList("status_id", query.statusIds);

  if (query.types !== undefined && query.types.length > 0) {
    clauses.push(`b.type IN (${query.types.map(() => "?").join(", ")})`);
    params.push(...query.types);
  }

  const text = query.text?.trim() ?? "";
  if (text.length > 0) {
    const fts = toFtsQuery(text);
    if (fts === null) return { clauses, params, impossible: true };
    // A folder has no `document` row and so no row in the index. Excluding it is not a
    // policy decision — there is nothing to search — but the author asked for words,
    // so a title-only match on a folder is offered as well.
    clauses.push(
      `(b.id IN (SELECT document_id FROM document_fts WHERE document_fts MATCH ?)
        OR (b.type = 'folder' AND b.title LIKE ? ESCAPE '\\'))`,
    );
    params.push(fts, `%${text.replace(/[%_]/g, "")}%`);
  }

  return { clauses, params, impossible: false };
}

const MEMBER_COLUMNS = "b.id, b.title, b.type, b.label_id, b.status_id";

interface MemberRow {
  id: string;
  title: string;
  type: "folder" | "document";
  label_id: string | null;
  status_id: string | null;
}

const toMember = (row: MemberRow): CollectionMember => ({
  id: row.id,
  title: row.title,
  type: row.type,
  labelId: row.label_id,
  statusId: row.status_id,
});

/**
 * What is in a collection right now.
 *
 * Both kinds exclude the trash and tombstones, and for the same reason: a collection is
 * a way of looking at the manuscript, and something the author threw away is not in
 * their manuscript. A trashed item stays on a saved list — its `collection_item` row is
 * untouched — and reappears the moment it is restored.
 */
export async function loadCollectionMembers(
  db: Reader,
  projectId: string,
  collection: Collection,
): Promise<CollectionMember[]> {
  // `LEFT JOIN ... trash` rather than a subquery on every row: a trashed item's parent
  // *is* the trash node, so one join answers it.
  const live = `b.project_id = ?
      AND b.deleted_at IS NULL
      AND b.type IN ('folder', 'document')
      AND trash.id IS NULL`;
  const from = `FROM binder_item b
       LEFT JOIN binder_item trash ON trash.id = b.parent_id AND trash.type = 'trash'`;

  if (!collection.isSmart) {
    const rows = await db.query<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} ${from}
         JOIN collection_item ci ON ci.binder_item_id = b.id
        WHERE ci.collection_id = ? AND ${live}
        ORDER BY ci.order_key, b.id`,
      [collection.id, projectId],
    );
    return rows.map(toMember);
  }

  const { clauses, params, impossible } = queryConditions(collection.query ?? {});
  if (impossible) return [];

  const rows = await db.query<MemberRow>(
    `SELECT ${MEMBER_COLUMNS} ${from}
      WHERE ${live}${clauses.map((clause) => `\n        AND ${clause}`).join("")}
      ORDER BY b.order_key, b.id`,
    [projectId, ...params],
  );
  return rows.map(toMember);
}

/** Which of the author's hand-made collections already hold this item. */
export async function loadMembershipsOf(
  db: Reader,
  projectId: string,
  binderItemId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db.query<{ collection_id: string }>(
    `SELECT ci.collection_id FROM collection_item ci
       JOIN collection c ON c.id = ci.collection_id
      WHERE ci.binder_item_id = ? AND c.project_id = ? AND c.deleted_at IS NULL`,
    [binderItemId, projectId],
  );
  return new Set(rows.map((row) => row.collection_id));
}

// -- commands ----------------------------------------------------------------------

export const createCollection = (
  db: DatabaseClient,
  projectId: string,
  name: string,
  query: CollectionQuery | null,
  color: string | null = null,
) => db.command("createCollection", { projectId, name, color, query });

export const renameCollection = (db: DatabaseClient, projectId: string, id: string, name: string) =>
  db.command("updateCollection", { projectId, id, name });

export const saveCollectionQuery = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  query: CollectionQuery,
) => db.command("updateCollection", { projectId, id, query });

export const deleteCollection = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("deleteCollection", { projectId, id });

export const addToCollection = (
  db: DatabaseClient,
  projectId: string,
  collectionId: string,
  binderItemId: string,
) => db.command("addToCollection", { projectId, collectionId, binderItemId });

export const removeFromCollection = (
  db: DatabaseClient,
  projectId: string,
  collectionId: string,
  binderItemId: string,
) => db.command("removeFromCollection", { projectId, collectionId, binderItemId });
