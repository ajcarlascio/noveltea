import type { SqlValue } from "@noveltea/client-db";
import type { DatabaseClient } from "@/db/client";

/**
 * Margin comments, read from the local replica.
 *
 * A comment points at a passage, and a passage moves. ProseMirror positions shift with
 * every character typed above them, so an anchor keeps the quoted text alongside its
 * offsets and the text is what decides whether the anchor still means anything.
 *
 * **A comment is never silently moved and never silently dropped.** If the words it
 * quoted are gone, it is shown as orphaned, with the quotation, so an author can see
 * what it was about and decide. Guessing a new position from a stale offset would
 * attach a note about one sentence to a different one — which is worse than saying
 * plainly that the sentence is gone.
 */

/** The read surface this module needs. See [[Reader]] in data/projects. */
interface Reader {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

export interface CommentAnchor {
  from: number;
  to: number;
  quotedText: string;
}

export interface Comment {
  id: string;
  documentId: string;
  parentId: string | null;
  body: string;
  anchor: CommentAnchor | null;
  /** The quoted text is no longer in the document. Never true for an unanchored note. */
  orphaned: boolean;
  resolved: boolean;
  createdAt: string;
  version: number;
}

export interface CommentThread {
  comment: Comment;
  replies: Comment[];
}

interface CommentRow {
  id: string;
  document_id: string;
  parent_comment_id: string | null;
  body: string;
  anchor: string | null;
  resolved_at: string | null;
  created_at: string;
  version: number;
}

/**
 * An anchor arrives as JSON from another device and is only trusted this far.
 *
 * A malformed one is treated as no anchor rather than as an error: the note itself is
 * still an author's words, and losing it because a position was written oddly would be
 * a worse outcome than showing it unanchored.
 */
export function parseAnchor(raw: string | null): CommentAnchor | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.quotedText !== "string") return null;
    return {
      from: typeof record.from === "number" ? record.from : 0,
      to: typeof record.to === "number" ? record.to : 0,
      quotedText: record.quotedText,
    };
  } catch {
    return null;
  }
}

/**
 * Whether an anchor still points at something.
 *
 * Matched against the document's flattened text rather than its offsets, because
 * offsets drift with every edit while the words usually survive. This is deliberately
 * the same rule the server applies in `CommentService.isOrphaned`: an author moving
 * between devices must not see a comment called orphaned in one place and live in the
 * other.
 *
 * Whitespace is normalised on both sides first. The quotation was taken from a
 * selection and the haystack from a block-per-line flattening, so a comment quoting
 * text that happens to span a line break would otherwise orphan itself the moment it
 * was made.
 */
export function isOrphaned(anchor: CommentAnchor | null, documentText: string | null): boolean {
  if (anchor === null) return false;
  const quoted = normalise(anchor.quotedText);
  if (quoted.length === 0) return false;
  return !normalise(documentText ?? "").includes(quoted);
}

const normalise = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Every comment on a document, threaded, oldest first.
 *
 * The document's text comes back in the same query so orphan state is decided from one
 * consistent read — asking separately leaves a window where an edit lands between the
 * two and comments are judged against text that was never on screen.
 */
export async function listComments(
  db: Reader,
  projectId: string,
  documentId: string,
): Promise<CommentThread[]> {
  const [documentRows, commentRows] = await Promise.all([
    db.query<{ search_text: string | null }>(
      `SELECT d.search_text
         FROM document d
         JOIN binder_item b ON b.id = d.id
        WHERE d.id = ? AND b.project_id = ?`,
      [documentId, projectId],
    ),
    db.query<CommentRow>(
      `SELECT c.id, c.document_id, c.parent_comment_id, c.body, c.anchor, c.resolved_at,
              c.created_at, c.version
         FROM comment c
         JOIN binder_item b ON b.id = c.document_id
        WHERE c.document_id = ? AND b.project_id = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at, c.id`,
      [documentId, projectId],
    ),
  ]);

  const text = documentRows[0]?.search_text ?? "";
  const toComment = (row: CommentRow): Comment => {
    const anchor = parseAnchor(row.anchor);
    return {
      id: row.id,
      documentId: row.document_id,
      parentId: row.parent_comment_id,
      body: row.body,
      anchor,
      orphaned: isOrphaned(anchor, text),
      resolved: row.resolved_at !== null,
      createdAt: row.created_at,
      version: row.version,
    };
  };

  const threads = new Map<string, CommentThread>();
  const orphanedReplies: Comment[] = [];

  for (const row of commentRows) {
    const comment = toComment(row);
    if (comment.parentId === null) {
      threads.set(comment.id, { comment, replies: [] });
      continue;
    }
    const parent = threads.get(comment.parentId);
    // A reply whose parent is missing still holds someone's words. Dropping it because
    // the row it pointed at was deleted elsewhere would lose them silently; it is
    // promoted to a thread of its own instead.
    if (parent) parent.replies.push(comment);
    else orphanedReplies.push(comment);
  }

  return [
    ...threads.values(),
    ...orphanedReplies.map((comment) => ({ comment, replies: [] })),
  ];
}

/** Open threads across a project — what the binder needs to badge a document. */
export async function countOpenComments(
  db: Reader,
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await db.query<{ document_id: string; open: number }>(
    `SELECT c.document_id, COUNT(*) AS open
       FROM comment c
       JOIN binder_item b ON b.id = c.document_id
      WHERE c.project_id = ? AND c.resolved_at IS NULL AND c.deleted_at IS NULL
        AND b.deleted_at IS NULL
      GROUP BY c.document_id`,
    [projectId],
  );
  return new Map(rows.map((row) => [row.document_id, row.open]));
}

export const addComment = (
  db: DatabaseClient,
  projectId: string,
  documentId: string,
  body: string,
  anchor: CommentAnchor | null = null,
  parentId: string | null = null,
) => db.command("addComment", { projectId, documentId, body, anchor, parentId });

export const editComment = (db: DatabaseClient, projectId: string, id: string, body: string) =>
  db.command("editComment", { projectId, id, body });

export const resolveComment = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  resolved: boolean,
) => db.command("resolveComment", { projectId, id, resolved });

export const deleteComment = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("deleteComment", { projectId, id });
