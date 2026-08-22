import type { SqlValue } from "@noveltea/client-db";
import type { DatabaseClient } from "@/db/client";
import { EMPTY_DOCUMENT } from "@/features/editor/schema";
import type { ProseMirrorNode } from "@/features/editor/text";

/** The read surface this module needs. See [[Reader]] in data/projects. */
interface Reader {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

export interface StoredDocument {
  id: string;
  title: string;
  content: ProseMirrorNode;
  wordCount: number;
  /** The version last synced. Local edits do not change it. */
  version: number;
}

interface DocumentRow {
  id: string;
  title: string;
  content: string;
  word_count: number;
  version: number;
}

/**
 * Reads one document, scoped through its binder item.
 *
 * Returns null rather than throwing when it is missing: an author can have a stale
 * link to a document another device trashed, and that is an ordinary outcome.
 */
export async function loadDocument(
  db: Reader,
  projectId: string,
  id: string,
): Promise<StoredDocument | null> {
  const rows = await db.query<DocumentRow>(
    `SELECT d.id, b.title, d.content, d.word_count, d.version
       FROM document d
       JOIN binder_item b ON b.id = d.id
      WHERE d.id = ? AND b.project_id = ? AND b.deleted_at IS NULL`,
    [id, projectId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    content: parseContent(row.content),
    wordCount: row.word_count,
    version: row.version,
  };
}

/**
 * Content is stored as text and arrives from other devices. Unparseable JSON opens
 * as an empty document rather than crashing the editor — the row is still there to
 * inspect, and an author locked out of the whole app has lost more than one scene.
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

export const saveDocument = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  content: unknown,
  searchText: string,
  wordCount: number,
  snapshotBefore = false,
) => db.command("saveDocument", { projectId, id, content, searchText, wordCount, snapshotBefore });
