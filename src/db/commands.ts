import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";
import {
  ITEM_COLUMNS,
  queueItem as queue,
  requireItem,
  type BinderItemRow,
} from "./binder-item";
import { COLLECTION_COMMANDS } from "./collection-commands";
import { COMMENT_COMMANDS } from "./comment-commands";
import { COMPILE_PRESET_COMMANDS } from "./compile-preset-commands";
import { METADATA_COMMANDS } from "./metadata-commands";
import { SNAPSHOT_COMMANDS } from "./snapshot-commands";
import { SYNC_COMMANDS } from "./sync-commands";
import { TAXONOMY_COMMANDS } from "./taxonomy-commands";
import { between } from "@/data/order";

/**
 * Writes that touch more than one table, executed in the worker next to the
 * database.
 *
 * Each is synchronous and runs inside one transaction (see `dispatch.ts`), which is
 * what lets a row change and its `pending_change` entry commit or fail together. A
 * binder edit that landed without its queue entry would never reach the server and
 * nothing would report it.
 *
 * Being plain synchronous functions over `SqliteAdapter`, they are also directly
 * testable against real SQLite in Node — no worker, no mocks.
 */

export type BinderItemType = "folder" | "document";

// Re-exported: the row shape moved to `binder-item.ts` when the taxonomy commands
// needed it too, and the tests and callers that name it here need not care.
export type { BinderItemRow };

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  // Clients mint ids. The server has to accept an id it did not choose anyway,
  // because an author creates items offline; `duplicate_create` exists for the
  // retry case where it has already seen this one.
  return crypto.randomUUID();
}

function trashNodeId(db: SqliteAdapter, projectId: string): string {
  const row = db.query<{ id: string }>(
    "SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';",
    [projectId],
  )[0];
  if (!row) throw new Error("This project has no trash node.");
  return row.id;
}

/** The order key for a new last child of `parentId`. */
function keyAtEnd(db: SqliteAdapter, projectId: string, parentId: string | null): string {
  const last = db.query<{ order_key: string }>(
    `SELECT order_key FROM binder_item
      WHERE project_id = ? AND parent_id IS ${parentId === null ? "NULL" : "?"}
        AND deleted_at IS NULL
      ORDER BY order_key DESC LIMIT 1;`,
    parentId === null ? [projectId] : [projectId, parentId],
  )[0];
  return between(last?.order_key ?? null, null);
}

/** The order key for a slot directly after `afterId`, or first when it is null. */
function keyAfter(
  db: SqliteAdapter,
  projectId: string,
  parentId: string | null,
  afterId: string | null,
  movingId?: string,
): string {
  const siblings = db.query<{ id: string; order_key: string }>(
    `SELECT id, order_key FROM binder_item
      WHERE project_id = ? AND parent_id IS ${parentId === null ? "NULL" : "?"}
        AND deleted_at IS NULL
      ORDER BY order_key;`,
    parentId === null ? [projectId] : [projectId, parentId],
  ).filter((row) => row.id !== movingId);

  if (afterId === null) {
    return between(null, siblings[0]?.order_key ?? null);
  }
  const index = siblings.findIndex((row) => row.id === afterId);
  if (index === -1) throw new Error("That item is not among the siblings being ordered.");
  return between(siblings[index]!.order_key, siblings[index + 1]?.order_key ?? null);
}

/** Ids of `id` and everything beneath it, live or trashed. */
function subtreeIds(db: SqliteAdapter, projectId: string, id: string): string[] {
  return db
    .query<{ id: string }>(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM binder_item WHERE id = ? AND project_id = ?
         UNION ALL
         SELECT b.id FROM binder_item b JOIN subtree s ON b.parent_id = s.id
       )
       SELECT id FROM subtree;`,
      [id, projectId],
    )
    .map((row) => row.id);
}

/**
 * Refuses a reparent that would put an item inside its own subtree.
 *
 * No CHECK constraint can express this, and without it a mis-ordered drag detaches
 * the subtree: the rows are still in the database but every read walks down from
 * the roots, so the chapters render nowhere. On the client that is a lost
 * manuscript with no server involved at all.
 */
function requireReparentIsSafe(
  db: SqliteAdapter,
  projectId: string,
  id: string,
  newParentId: string | null,
): void {
  if (newParentId === null) return;
  if (newParentId === id) throw new Error("An item cannot be moved inside itself.");
  const parent = requireItem(db, projectId, newParentId);
  if (parent.deleted_at !== null) throw new Error("That destination no longer exists.");
  if (subtreeIds(db, projectId, id).includes(newParentId)) {
    throw new Error("An item cannot be moved inside itself.");
  }
}

// ---------------------------------------------------------------------------------

export interface CreateProjectInput {
  title: string;
}

export interface CreateBinderItemInput {
  projectId: string;
  parentId: string | null;
  type: BinderItemType;
  title: string;
}

export interface RenameBinderItemInput {
  projectId: string;
  id: string;
  title: string;
}

export interface MoveBinderItemInput {
  projectId: string;
  id: string;
  parentId: string | null;
  /** Place directly after this sibling; null means first. */
  afterId: string | null;
}

export interface BinderItemRef {
  projectId: string;
  id: string;
}

export interface SaveDocumentInput {
  projectId: string;
  id: string;
  /** ProseMirror JSON. Stored as text; never interpreted here. */
  content: unknown;
  /** Flattened prose, for offline search and for the server's tsvector. */
  searchText: string;
  wordCount: number;
  /**
   * Capture the content being replaced as an automatic snapshot, in this same write.
   *
   * A separate command would do the job, but not atomically and not in one round trip
   * to the worker. Both matter: the capture has to read the previous content, so it
   * must land before the overwrite, and making the author's words wait on a second
   * transaction delays the only write that actually matters.
   */
  snapshotBefore?: boolean;
}

export interface DocumentRow {
  id: string;
  content: string;
  search_text: string | null;
  word_count: number;
  /** The index-card summary. Null and empty mean the same thing: there isn't one. */
  synopsis: string | null;
  notes: string | null;
  version: number;
  updated_at: string;
}

export interface SaveSynopsisInput {
  projectId: string;
  id: string;
  /** Null, or blank, clears it. */
  synopsis: string | null;
}

/** Every syncable column on a document row, in one place so no reader can forget one. */
const DOCUMENT_COLUMNS =
  "id, content, search_text, word_count, synopsis, notes, version, updated_at";

function requireDocumentRow(db: SqliteAdapter, id: string): DocumentRow {
  const row = db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM document WHERE id = ?;`,
    [id],
  )[0];
  if (!row) throw new Error("That document has no body row.");
  return row;
}

/**
 * Queues a document for sync, always as the whole row.
 *
 * Not an efficiency choice — the opposite. `pending_change` holds **at most one entry
 * per entity**, and merging a second change replaces the payload outright rather than
 * combining it. So a partial payload is a promise that no other pane will ever write
 * this document before the queue drains, and that promise is false: the editor saves
 * prose while the corkboard saves index cards, and whichever went last would silently
 * drop the other's field from the push.
 *
 * Sending the row back in full makes coalescing correct by construction. The server
 * reads a missing key as "leave it alone", so this is belt and braces — but the belt is
 * the half that survives someone adding a third pane.
 */
function queueDocument(db: SqliteAdapter, projectId: string, row: DocumentRow): void {
  enqueueChange(db, {
    projectId,
    entityType: "document",
    entityId: row.id,
    op: "update",
    payload: {
      id: row.id,
      // Valid JSON by the table's own CHECK constraint, so this cannot be the thing
      // that throws here.
      content: JSON.parse(row.content) as unknown,
      search_text: row.search_text,
      word_count: row.word_count,
      synopsis: row.synopsis,
      notes: row.notes,
      updated_at: row.updated_at,
    },
    // Local edits never bump version; the server assigns it. This is the version
    // last synced, which is what the server checks the push against.
    baseVersion: row.version,
  });
}

export const COMMANDS = {
  /**
   * Creates a project and its trash node locally.
   *
   * Nothing is queued: `pending_change` has no `project` entity type, because the
   * sync endpoint is scoped by a project id in its path and so cannot carry the
   * creation of one. A project made offline therefore does not reach the server
   * yet — see README, "Creating a project offline".
   */
  createProject: (db: SqliteAdapter, input: CreateProjectInput): { id: string; title: string } => {
    const title = input.title.trim();
    if (title.length === 0) throw new Error("A project needs a title.");

    const id = newId();
    const stamp = now();
    db.run(
      "INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?);",
      [id, title, stamp, stamp],
    );
    db.run(
      `INSERT INTO binder_item (id, project_id, parent_id, type, title, order_key, created_at, updated_at)
       VALUES (?, ?, NULL, 'trash', 'Trash', ?, ?, ?);`,
      [newId(), id, between(null, null), stamp, stamp],
    );
    return { id, title };
  },

  createBinderItem: (db: SqliteAdapter, input: CreateBinderItemInput): BinderItemRow => {
    const title = input.title.trim();
    if (title.length === 0) throw new Error("A title cannot be empty.");
    if (input.parentId !== null) {
      const parent = requireItem(db, input.projectId, input.parentId);
      if (parent.type === "document") {
        throw new Error("A document cannot contain other items.");
      }
    }

    const id = newId();
    const stamp = now();
    db.run(
      `INSERT INTO binder_item (id, project_id, parent_id, type, title, order_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.projectId,
        input.parentId,
        input.type,
        title,
        keyAtEnd(db, input.projectId, input.parentId),
        stamp,
        stamp,
      ],
    );

    if (input.type === "document") {
      db.run(
        "INSERT INTO document (id, created_at, updated_at) VALUES (?, ?, ?);",
        [id, stamp, stamp],
      );
    }

    const row = requireItem(db, input.projectId, id);
    queue(db, row, "create");
    return row;
  },

  renameBinderItem: (db: SqliteAdapter, input: RenameBinderItemInput): BinderItemRow => {
    const title = input.title.trim();
    if (title.length === 0) throw new Error("A title cannot be empty.");

    const existing = requireItem(db, input.projectId, input.id);
    if (existing.type === "trash") throw new Error("The trash cannot be renamed.");

    db.run("UPDATE binder_item SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?;", [
      title,
      now(),
      input.id,
      input.projectId,
    ]);
    const row = requireItem(db, input.projectId, input.id);
    queue(db, row, "update");
    return row;
  },

  moveBinderItem: (db: SqliteAdapter, input: MoveBinderItemInput): BinderItemRow => {
    const existing = requireItem(db, input.projectId, input.id);
    if (existing.type === "trash") throw new Error("The trash cannot be moved.");
    requireReparentIsSafe(db, input.projectId, input.id, input.parentId);

    if (input.parentId !== null) {
      const parent = requireItem(db, input.projectId, input.parentId);
      if (parent.type === "document") {
        throw new Error("A document cannot contain other items.");
      }
    }

    db.run(
      `UPDATE binder_item SET parent_id = ?, order_key = ?, updated_at = ?
        WHERE id = ? AND project_id = ?;`,
      [
        input.parentId,
        keyAfter(db, input.projectId, input.parentId, input.afterId, input.id),
        now(),
        input.id,
        input.projectId,
      ],
    );
    const row = requireItem(db, input.projectId, input.id);
    queue(db, row, "update");
    return row;
  },

  /**
   * Moves an item to the trash. Trashing is a move, not a delete: the item keeps
   * syncing and stays restorable, and `deleted_at` is reserved for the tombstone
   * written when the trash is emptied.
   */
  trashBinderItem: (db: SqliteAdapter, input: BinderItemRef): BinderItemRow => {
    const existing = requireItem(db, input.projectId, input.id);
    if (existing.type === "trash") throw new Error("The trash cannot be trashed.");

    const trash = trashNodeId(db, input.projectId);
    if (existing.parent_id === trash) {
      // Already there. Re-trashing must not overwrite trashed_from_parent_id with
      // the trash node itself — that would make the item permanently unrestorable.
      return existing;
    }

    db.run(
      `UPDATE binder_item
          SET parent_id = ?, trashed_from_parent_id = ?, order_key = ?, updated_at = ?
        WHERE id = ? AND project_id = ?;`,
      [trash, existing.parent_id, keyAtEnd(db, input.projectId, trash), now(), input.id, input.projectId],
    );
    const row = requireItem(db, input.projectId, input.id);
    queue(db, row, "update");
    return row;
  },

  /** Puts a trashed item back where it came from, or at the root if that is gone. */
  restoreBinderItem: (db: SqliteAdapter, input: BinderItemRef): BinderItemRow => {
    const existing = requireItem(db, input.projectId, input.id);
    const trash = trashNodeId(db, input.projectId);

    if (existing.parent_id !== trash) {
      // Restoring something that is not in the trash is a no-op, not a move to the
      // root: doing otherwise silently relocates a live item the author can see.
      return existing;
    }

    let destination = existing.trashed_from_parent_id;
    if (destination !== null) {
      const parent = db.query<BinderItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM binder_item WHERE id = ? AND project_id = ?;`,
        [destination, input.projectId],
      )[0];
      // Falling back to the root rather than refusing: a refusal strands the item
      // somewhere the author cannot reach it.
      if (!parent || parent.deleted_at !== null || parent.parent_id === trash) destination = null;
    }

    db.run(
      `UPDATE binder_item
          SET parent_id = ?, trashed_from_parent_id = NULL, order_key = ?, updated_at = ?
        WHERE id = ? AND project_id = ?;`,
      [
        destination,
        keyAtEnd(db, input.projectId, destination),
        now(),
        input.id,
        input.projectId,
      ],
    );
    const row = requireItem(db, input.projectId, input.id);
    queue(db, row, "update");
    return row;
  },

  /**
   * Writes a document's body.
   *
   * The content is stored as text and never inspected: only the editor understands
   * the schema. `search_text` and `word_count` are computed by the caller for the
   * same reason — the server cannot produce them, because the JVM never walks a
   * document.
   */
  saveDocument: (db: SqliteAdapter, input: SaveDocumentInput): DocumentRow => {
    // `document` has no project_id of its own; it is scoped through its binder item,
    // exactly as the server scopes it. Without this an id learned from anywhere would
    // write into another project.
    const item = requireItem(db, input.projectId, input.id);
    if (item.type !== "document") throw new Error("That item is not a document.");
    if (item.deleted_at !== null) throw new Error("That document has been deleted.");
    if (!Number.isInteger(input.wordCount) || input.wordCount < 0) {
      throw new Error("A word count must be a non-negative whole number.");
    }

    if (input.snapshotBefore === true) {
      SNAPSHOT_COMMANDS.captureSnapshot(db, {
        projectId: input.projectId,
        documentId: input.id,
        label: null,
        automatic: true,
      });
    }

    const stamp = now();
    db.run(
      `UPDATE document SET content = ?, search_text = ?, word_count = ?, updated_at = ?
        WHERE id = ?;`,
      [JSON.stringify(input.content), input.searchText, input.wordCount, stamp, input.id],
    );

    const row = requireDocumentRow(db, input.id);
    queueDocument(db, input.projectId, row);
    return row;
  },

  /**
   * Writes a document's index card.
   *
   * Its own command rather than an argument to `saveDocument`, because the two are
   * written by different panes at different moments and neither should have to know
   * the other's field. What they do share is the queue entry, which is why both go
   * through `queueDocument`.
   *
   * No snapshot is taken. Snapshots exist to protect prose from a bad revision pass;
   * a synopsis is a note about the prose, and capturing the whole manuscript every time
   * somebody tidies a card would fill the history with nothing.
   */
  saveSynopsis: (db: SqliteAdapter, input: SaveSynopsisInput): DocumentRow => {
    // Scoped through the binder item, exactly as saveDocument is: without this an id
    // learned from anywhere would write into another project.
    const item = requireItem(db, input.projectId, input.id);
    if (item.type !== "document") throw new Error("That item is not a document.");
    if (item.deleted_at !== null) throw new Error("That document has been deleted.");

    // An emptied card has no synopsis; it does not have an empty one. Stored as null so
    // "is there a summary?" is one question everywhere rather than two.
    const trimmed = input.synopsis === null ? null : input.synopsis.trim();
    const synopsis = trimmed === null || trimmed.length === 0 ? null : trimmed;

    db.run("UPDATE document SET synopsis = ?, updated_at = ? WHERE id = ?;", [
      synopsis,
      now(),
      input.id,
    ]);

    const row = requireDocumentRow(db, input.id);
    queueDocument(db, input.projectId, row);
    return row;
  },

  /**
   * Tombstones everything in the trash.
   *
   * Rows are kept, never removed: a tombstone is what tells another device the item
   * is gone. Each item in each trashed subtree gets its own row and its own queue
   * entry, or a child would stay live under a parent that has vanished.
   */
  emptyTrash: (db: SqliteAdapter, input: { projectId: string }): { deleted: number } => {
    const trash = trashNodeId(db, input.projectId);
    const roots = db.query<{ id: string }>(
      "SELECT id FROM binder_item WHERE project_id = ? AND parent_id = ? AND deleted_at IS NULL;",
      [input.projectId, trash],
    );

    const stamp = now();
    const ids = new Set<string>();
    for (const root of roots) {
      for (const id of subtreeIds(db, input.projectId, root.id)) ids.add(id);
    }

    for (const id of ids) {
      db.run(
        "UPDATE binder_item SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL;",
        [stamp, stamp, id],
      );
      const row = requireItem(db, input.projectId, id);
      queue(db, row, "delete");
    }
    return { deleted: ids.size };
  },
  /**
   * Merges a patch into `project.settings`.
   *
   * Nothing is queued, and that is not an oversight: `pending_change` has no `project`
   * entity type, because the sync endpoint is scoped by a project id in its path and so
   * cannot carry a change to the project row itself. Word targets are therefore
   * per-replica until the client learns to PATCH `/projects/{id}` directly — the same
   * gap project creation has, and worth knowing before promising an author their target
   * follows them to another machine.
   *
   * Merged rather than replaced. The column is a shared bag: a future build may keep
   * compile defaults in it, and writing the whole object would delete whatever this
   * version does not know about. That is the opposite of the rule for a collection's
   * query, where an unknown key is dropped — there, keeping it would claim a condition
   * this build cannot apply; here, dropping it destroys another client's configuration.
   */
  saveProjectSettings: (
    db: SqliteAdapter,
    input: { projectId: string; patch: Record<string, unknown> },
  ): { settings: Record<string, unknown> } => {
    const row = db.query<{ settings: string }>("SELECT settings FROM project WHERE id = ?;", [
      input.projectId,
    ])[0];
    if (!row) throw new Error("That project is not on this device.");

    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.settings);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // A CHECK keeps malformed JSON out, so this is a value of another shape. Starting
      // from empty loses less than refusing to save anything ever again.
    }

    const next = { ...current };
    for (const [key, value] of Object.entries(input.patch)) {
      // Null removes the key rather than storing a null, so "no target" is the absence
      // of a target and every reader agrees about it without a special case.
      if (value === null) delete next[key];
      else next[key] = value;
    }

    db.run("UPDATE project SET settings = ?, updated_at = ? WHERE id = ?;", [
      JSON.stringify(next),
      now(),
      input.projectId,
    ]);
    return { settings: next };
  },

  ...COMMENT_COMMANDS,
  ...SNAPSHOT_COMMANDS,
  ...SYNC_COMMANDS,
  ...TAXONOMY_COMMANDS,
  ...COLLECTION_COMMANDS,
  ...COMPILE_PRESET_COMMANDS,
  ...METADATA_COMMANDS,
} satisfies Record<string, (db: SqliteAdapter, input: never) => unknown>;

/**
 * Commands that only read.
 *
 * `DatabaseClient` announces a change after every other command, and anything
 * listening re-reads. A read-only command that announced one would wake the listener
 * that just called it — `syncState` refreshing a status which calls `syncState` —
 * and the page would spin instead of rendering.
 *
 * Listed rather than inferred: a new read-only command is rare, and being wrong in
 * this direction only costs a redundant read, while being wrong in the other costs a
 * loop.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "syncState",
  "listTaxonomy",
  "listCollections",
  "listCompilePresets",
  "listMetadataFields",
]);

export type CommandName = keyof typeof COMMANDS;
export type CommandInput<K extends CommandName> = Parameters<(typeof COMMANDS)[K]>[1];
export type CommandResult<K extends CommandName> = ReturnType<(typeof COMMANDS)[K]>;
