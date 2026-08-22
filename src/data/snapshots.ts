import type { SqlValue } from "@noveltea/client-db";
import type { DatabaseClient } from "@/db/client";
import { EMPTY_DOCUMENT } from "@/features/editor/schema";
import type { ProseMirrorNode } from "@/features/editor/text";

/**
 * Revision history, read from the local replica.
 *
 * Every read here is a local SQLite query, so the history opens at the speed of a
 * keystroke and works with no server at all. That matters more than it sounds: the
 * moment an author wants an old draft back, they usually want it *now*, and often
 * because something has just gone wrong.
 *
 * **Manual snapshots sync; automatic ones do not.** An automatic capture is this
 * device's safety net and is pruned to a bound, so pushing them would mean every
 * device's undo history arriving on every other device. A manual one is something
 * the author asked for by name, and travels.
 */

/** The read surface this module needs. See [[Reader]] in data/projects. */
interface Reader {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

export interface SnapshotSummary {
  id: string;
  documentId: string;
  label: string | null;
  automatic: boolean;
  wordCount: number;
  createdAt: string;
}

export interface SnapshotBody extends SnapshotSummary {
  content: ProseMirrorNode;
}

interface SummaryRow {
  id: string;
  document_id: string;
  label: string | null;
  is_automatic: number;
  word_count: number;
  created_at: string;
}

interface BodyRow extends SummaryRow {
  content: string;
}

const toSummary = (row: SummaryRow): SnapshotSummary => ({
  id: row.id,
  documentId: row.document_id,
  label: row.label,
  // SQLite has no boolean; the column is a 0/1 INTEGER with a CHECK.
  automatic: row.is_automatic === 1,
  wordCount: row.word_count,
  createdAt: row.created_at,
});

/**
 * A document's history, newest first.
 *
 * Scoped through the binder item rather than by `document_id` alone, so an id learned
 * from anywhere cannot read another project's drafts.
 */
export async function listSnapshots(
  db: Reader,
  projectId: string,
  documentId: string,
): Promise<SnapshotSummary[]> {
  const rows = await db.query<SummaryRow>(
    `SELECT s.id, s.document_id, s.label, s.is_automatic, s.word_count, s.created_at
       FROM snapshot s
       JOIN binder_item b ON b.id = s.document_id
      WHERE s.document_id = ? AND b.project_id = ?
      ORDER BY s.created_at DESC, s.id DESC`,
    [documentId, projectId],
  );
  return rows.map(toSummary);
}

/** Null when the snapshot is gone — another device can have pruned or deleted it. */
export async function loadSnapshot(
  db: Reader,
  projectId: string,
  id: string,
): Promise<SnapshotBody | null> {
  const rows = await db.query<BodyRow>(
    `SELECT s.id, s.document_id, s.label, s.is_automatic, s.word_count, s.created_at, s.content
       FROM snapshot s
       JOIN binder_item b ON b.id = s.document_id
      WHERE s.id = ? AND b.project_id = ?`,
    [id, projectId],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...toSummary(row), content: parseContent(row.content) };
}

/**
 * Snapshot content arrives from other devices and is stored as text. Unparseable JSON
 * opens as an empty document rather than throwing: the row stays there to inspect, and
 * one bad snapshot must not take the whole history down with it.
 */
function parseContent(raw: string): ProseMirrorNode {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // fall through
  }
  return { ...EMPTY_DOCUMENT };
}

export const captureSnapshot = (
  db: DatabaseClient,
  projectId: string,
  documentId: string,
  label: string | null,
  automatic = false,
) => db.command("captureSnapshot", { projectId, documentId, label, automatic });

export const restoreSnapshot = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("restoreSnapshot", { projectId, id });

export const deleteSnapshot = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("deleteSnapshot", { projectId, id });
