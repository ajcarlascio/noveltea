import { enqueueChange, type SqliteAdapter } from "@noveltea/client-db";

/**
 * Margin comments, written next to the database.
 *
 * Every update carries the comment's **whole state**, not just the field that changed.
 * `pending_change` holds one row per entity and coalesces by replacing the payload, so
 * an edit followed by a resolve would otherwise arrive as a resolve alone and the edit
 * would be gone. The server reads an unchanged body as "not an edit" for exactly this
 * reason, which is what keeps a resolve out of the author-only path.
 *
 * Authorship is never sent. The server takes it from the pushing device's owner —
 * a client that could name an author could attribute a remark to someone else.
 */

function now(): string {
  return new Date().toISOString();
}

export interface CommentAnchorInput {
  from: number;
  to: number;
  quotedText: string;
}

export interface AddCommentInput {
  projectId: string;
  documentId: string;
  body: string;
  anchor: CommentAnchorInput | null;
  parentId: string | null;
}

export interface EditCommentInput {
  projectId: string;
  id: string;
  body: string;
}

export interface ResolveCommentInput {
  projectId: string;
  id: string;
  resolved: boolean;
}

export interface DeleteCommentInput {
  projectId: string;
  id: string;
}

export interface CommentIdRow {
  id: string;
}

interface CommentState {
  id: string;
  document_id: string;
  parent_comment_id: string | null;
  body: string;
  anchor: string | null;
  resolved_at: string | null;
  version: number;
}

const COMMENT_COLUMNS = `c.id, c.document_id, c.parent_comment_id, c.body, c.anchor,
  c.resolved_at, c.version`;

function requireComment(db: SqliteAdapter, projectId: string, id: string): CommentState {
  const row = db.query<CommentState>(
    `SELECT ${COMMENT_COLUMNS}
       FROM comment c
      WHERE c.id = ? AND c.project_id = ? AND c.deleted_at IS NULL;`,
    [id, projectId],
  )[0];
  if (!row) throw new Error("That comment is not in this project.");
  return row;
}

function requireDocument(db: SqliteAdapter, projectId: string, documentId: string): void {
  const row = db.query<{ id: string }>(
    `SELECT id FROM binder_item
      WHERE id = ? AND project_id = ? AND type = 'document' AND deleted_at IS NULL;`,
    [documentId, projectId],
  )[0];
  if (!row) throw new Error("That document is not in this project.");
}

/** The payload every comment update sends. See the note at the top of this file. */
function updatePayload(row: CommentState): Record<string, unknown> {
  return { id: row.id, body: row.body, resolved: row.resolved_at !== null };
}

export const COMMENT_COMMANDS = {
  addComment: (db: SqliteAdapter, input: AddCommentInput): CommentIdRow => {
    const body = input.body.trim();
    if (body.length === 0) throw new Error("A comment needs something in it.");
    requireDocument(db, input.projectId, input.documentId);

    let anchor = input.anchor;
    if (input.parentId !== null) {
      const parent = requireComment(db, input.projectId, input.parentId);
      if (parent.document_id !== input.documentId) {
        // The server refuses this too. A thread pointing at two documents is not a
        // thread, and a reply that crossed one would surface inside a conversation
        // it was never part of.
        throw new Error("That reply belongs to a thread on another document.");
      }
      if (parent.parent_comment_id !== null) {
        throw new Error("Replies do not have replies of their own.");
      }
      // A reply inherits the thread's anchor. Carrying its own would let one thread
      // point at two passages, and the schema refuses it outright.
      anchor = null;
    }

    const id = crypto.randomUUID();
    const stamp = now();
    db.run(
      `INSERT INTO comment
         (id, project_id, document_id, parent_comment_id, body, anchor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.projectId,
        input.documentId,
        input.parentId,
        body,
        anchor === null ? null : JSON.stringify(anchor),
        stamp,
        stamp,
      ],
    );

    enqueueChange(db, {
      projectId: input.projectId,
      entityType: "comment",
      entityId: id,
      op: "create",
      payload: {
        id,
        document_id: input.documentId,
        parent_comment_id: input.parentId,
        body,
        anchor,
        created_at: stamp,
      },
    });
    return { id };
  },

  editComment: (db: SqliteAdapter, input: EditCommentInput): CommentIdRow => {
    const body = input.body.trim();
    if (body.length === 0) throw new Error("A comment needs something in it.");

    const before = requireComment(db, input.projectId, input.id);
    const stamp = now();
    db.run("UPDATE comment SET body = ?, updated_at = ? WHERE id = ?;", [body, stamp, input.id]);

    enqueueChange(db, {
      projectId: input.projectId,
      entityType: "comment",
      entityId: input.id,
      op: "update",
      payload: updatePayload({ ...before, body }),
      baseVersion: before.version,
    });
    return { id: input.id };
  },

  /**
   * Closes or reopens a thread.
   *
   * `resolved_by_user_id` is left alone: the server assigns it from the pushing
   * device's owner, and a local guess would be overwritten on the next pull anyway.
   */
  resolveComment: (db: SqliteAdapter, input: ResolveCommentInput): CommentIdRow => {
    const before = requireComment(db, input.projectId, input.id);
    const stamp = now();
    db.run("UPDATE comment SET resolved_at = ?, updated_at = ? WHERE id = ?;", [
      input.resolved ? stamp : null,
      stamp,
      input.id,
    ]);

    enqueueChange(db, {
      projectId: input.projectId,
      entityType: "comment",
      entityId: input.id,
      op: "update",
      payload: updatePayload({ ...before, resolved_at: input.resolved ? stamp : null }),
      baseVersion: before.version,
    });
    return { id: input.id };
  },

  /**
   * A soft delete, matching the server.
   *
   * A hard delete locally would make the row reappear on the next pull, because the
   * server keeps its own tombstone and the client would have nothing to say it had
   * gone. Replies keep their parent row, so a thread does not lose its shape.
   */
  deleteComment: (db: SqliteAdapter, input: DeleteCommentInput): CommentIdRow => {
    const before = requireComment(db, input.projectId, input.id);
    const stamp = now();
    db.run("UPDATE comment SET deleted_at = ?, updated_at = ? WHERE id = ?;", [
      stamp,
      stamp,
      input.id,
    ]);

    enqueueChange(db, {
      projectId: input.projectId,
      entityType: "comment",
      entityId: input.id,
      op: "delete",
      baseVersion: before.version,
    });
    return { id: input.id };
  },
} as const;
