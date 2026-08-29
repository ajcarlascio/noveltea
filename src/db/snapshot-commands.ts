import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";
import { queueDocument, requireDocumentRow } from "@/db/commands";
import { summarise, type ProseMirrorNode } from "@/features/editor/text";

/**
 * Revision history, written next to the database.
 *
 * **Manual snapshots are queued for push; automatic ones never leave this device.**
 * An automatic capture is the editor's safety net and is pruned to a bound, so
 * syncing them would put every device's undo history on every other device. A manual
 * one is something the author named on purpose, and it travels.
 *
 * The server holds the same split (`SnapshotService`), and the same prune bound. The
 * client keeps its own copy of that number rather than asking for it, because
 * automatic captures are local and pruning them must work with no server at all.
 */

/**
 * How many automatic captures a document keeps.
 *
 * Matches the server's `noveltea.snapshot.keep-automatic-per-document`. It is a
 * duplicated constant on purpose: the two prune different sets of rows (the server
 * never sees these) and neither can wait on the other.
 */
export const KEEP_AUTOMATIC_PER_DOCUMENT = 25;

function now(): string {
  return new Date().toISOString();
}

interface DocumentState {
  id: string;
  content: string;
  word_count: number;
  version: number;
}

/**
 * The document a snapshot is of, scoped through its binder item.
 *
 * Scoping matters as much here as on the document itself: without it, an id learned
 * from anywhere would capture — or restore over — another project's prose.
 */
function requireDocument(db: SqliteAdapter, projectId: string, documentId: string): DocumentState {
  const row = db.query<DocumentState>(
    `SELECT d.id, d.content, d.word_count, d.version
       FROM document d
       JOIN binder_item b ON b.id = d.id
      WHERE d.id = ? AND b.project_id = ? AND b.deleted_at IS NULL;`,
    [documentId, projectId],
  )[0];
  if (!row) throw new Error("That document is not in this project.");
  return row;
}

function parseContent(raw: string): ProseMirrorNode {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // fall through
  }
  return { type: "doc", content: [] };
}

/**
 * Drops the oldest automatic captures past the bound.
 *
 * Only automatic ones. A manual snapshot is something the author asked for, and
 * deleting it on their behalf is not this command's decision — the same rule the
 * server holds to.
 */
function pruneAutomatic(db: SqliteAdapter, documentId: string): void {
  db.run(
    `DELETE FROM snapshot
      WHERE id IN (
        SELECT id FROM snapshot
         WHERE document_id = ? AND is_automatic = 1
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?);`,
    [documentId, KEEP_AUTOMATIC_PER_DOCUMENT],
  );
}

export interface CaptureSnapshotInput {
  projectId: string;
  documentId: string;
  label: string | null;
  automatic: boolean;
}

export interface RestoreSnapshotInput {
  projectId: string;
  id: string;
}

export interface DeleteSnapshotInput {
  projectId: string;
  id: string;
}

export interface SnapshotIdRow {
  id: string;
}

interface SnapshotState {
  id: string;
  document_id: string;
  content: string | null;
  word_count: number;
  is_automatic: number;
}

function requireSnapshot(db: SqliteAdapter, projectId: string, id: string): SnapshotState {
  const row = db.query<SnapshotState>(
    `SELECT s.id, s.document_id, s.content, s.word_count, s.is_automatic
       FROM snapshot s
       JOIN binder_item b ON b.id = s.document_id
      WHERE s.id = ? AND b.project_id = ?;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That snapshot is not in this project.");
  return row;
}

export const SNAPSHOT_COMMANDS = {
  captureSnapshot: (db: SqliteAdapter, input: CaptureSnapshotInput): SnapshotIdRow => {
    const document = requireDocument(db, input.projectId, input.documentId);
    const label = input.label?.trim() ?? "";

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO snapshot
         (id, project_id, document_id, content, word_count, label, is_automatic, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.projectId,
        input.documentId,
        document.content,
        document.word_count,
        label.length > 0 ? label : null,
        input.automatic ? 1 : 0,
        stamp,
        stamp,
      ],
    );

    if (input.automatic) {
      pruneAutomatic(db, input.documentId);
      return { id };
    }

    enqueueChange(db, {
      projectId: input.projectId,
      entityType: "snapshot",
      entityId: id,
      op: "create",
      payload: {
        id,
        document_id: input.documentId,
        content: JSON.parse(document.content) as unknown,
        word_count: document.word_count,
        label: label.length > 0 ? label : null,
        is_automatic: false,
        created_at: stamp,
      },
    });
    return { id };
  },

  /**
   * Puts a snapshot's content back into its document.
   *
   * Captures the current state automatically first, so a restore is itself undoable —
   * an author who reverts to the wrong draft has not lost the newer one. The server
   * does exactly the same on its own restore path.
   *
   * The document's `version` is deliberately not touched. Local edits never bump it;
   * the server assigns it, and a restore is an ordinary local edit that happens to
   * replace the whole body.
   */
  restoreSnapshot: (db: SqliteAdapter, input: RestoreSnapshotInput): SnapshotIdRow => {
    const snapshot = requireSnapshot(db, input.projectId, input.id);
    if (snapshot.content === null) {
      throw new Error("This snapshot's content has not been downloaded yet.");
    }
    // Called for its check, not its value: it refuses a document that is not in this
    // project. The row itself is re-read after the update, below.
    requireDocument(db, input.projectId, snapshot.document_id);

    SNAPSHOT_COMMANDS.captureSnapshot(db, {
      projectId: input.projectId,
      documentId: snapshot.document_id,
      label: "Before restore",
      automatic: true,
    });

    // search_text has to be recomputed here, not carried from the snapshot row, which
    // does not store it. Skipping it would leave offline search matching the text the
    // author just replaced — the one place where stale search results are silent.
    const restored = parseContent(snapshot.content);
    const { searchText, words } = summarise(restored);
    const stamp = now();

    db.run(
      `UPDATE document SET content = ?, search_text = ?, word_count = ?, updated_at = ?
        WHERE id = ?;`,
      [snapshot.content, searchText, words, stamp, snapshot.document_id],
    );

    // Queued through the shared writer, and as the whole row, for the reason its own
    // comment gives: pending_change holds one entry per entity and coalescing *replaces*
    // the payload. This used to build its own payload with content and word count only,
    // so restoring a snapshot after editing an index card — offline, or inside the
    // fifteen-minute window — replaced the queued row and dropped the synopsis and notes
    // from the push. Locally they were fine, so nothing looked wrong; the server and
    // every other device simply never heard about that edit.
    queueDocument(db, input.projectId, requireDocumentRow(db, snapshot.document_id));

    return { id: snapshot.document_id };
  },

  /**
   * Forgets a snapshot.
   *
   * An automatic one never reached the server, so deleting it locally is the whole of
   * it — queueing a delete for a row the server has never heard of would be rejected
   * as a phantom on every push until something gave up.
   */
  deleteSnapshot: (db: SqliteAdapter, input: DeleteSnapshotInput): SnapshotIdRow => {
    const snapshot = requireSnapshot(db, input.projectId, input.id);
    db.run("DELETE FROM snapshot WHERE id = ?;", [input.id]);

    if (snapshot.is_automatic === 0) {
      enqueueChange(db, {
        projectId: input.projectId,
        entityType: "snapshot",
        entityId: input.id,
        op: "delete",
      });
    }
    return { id: input.id };
  },
} as const;
