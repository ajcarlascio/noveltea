import type { SqlValue } from "@noveltea/client-db";

/**
 * Offline search over the local replica.
 *
 * Everything an author searches for is here on the device, so this works on a plane.
 * It covers titles, synopses, body text and notes — synopses and notes are never
 * exported, but they are exactly what someone searches to find a scene again, so
 * leaving them out would make them write-only.
 */

interface Reader {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

export interface SearchHit {
  id: string;
  title: string;
  type: "document" | "folder";
  /** Where the match was found, for showing context. */
  snippet: string;
  trashed: boolean;
}

export interface SearchOptions {
  /** Trashed items are excluded unless asked for, and flagged when included. */
  includeTrashed?: boolean;
  limit?: number;
}

/**
 * Turns what someone typed into an FTS5 query.
 *
 * FTS5 does not tolerate malformed input the way Postgres's `websearch_to_tsquery`
 * does — a stray quote or a bare `AND` raises a syntax error, which would surface to
 * an author mid-sentence as a crash. So the input is never passed through: it is
 * tokenised and rebuilt, and anything that cannot be understood is dropped rather
 * than escaped and hoped for.
 *
 * Supports what people actually type: bare words, "quoted phrases", and -exclusions.
 *
 * @returns null when there is nothing to search for, which means no results rather
 *   than every result.
 */
export function toFtsQuery(input: string): string | null {
  const tokens: string[] = [];
  // Quoted phrases first, so their spaces survive; then bare runs of non-space.
  const pattern = /(-?)"([^"]*)"|(-?)(\S+)/g;

  for (const match of input.matchAll(pattern)) {
    const quoted = match[2] !== undefined;
    const negated = (match[1] ?? match[3] ?? "") === "-";
    const raw = (match[2] ?? match[4] ?? "").trim();

    // Strip everything FTS5 treats as syntax. What is left is what the author meant:
    // words. Escaping would keep the characters and still change the query's meaning.
    const cleaned = raw.replace(/["*():^-]/g, " ").trim();
    if (cleaned.length === 0) continue;

    // Adjacency is only implied when it was asked for. A quoted phrase stays one
    // phrase; a bare word that happened to contain punctuation — `light(house)` —
    // becomes the words around it, because requiring them to be adjacent would be
    // guessing at something the author never said.
    const parts = quoted ? [cleaned] : cleaned.split(/\s+/);
    for (const part of parts) {
      const phrase = `"${part}"`;
      tokens.push(negated ? `NOT ${phrase}` : phrase);
    }
  }

  if (tokens.length === 0) return null;

  // A leading NOT is not a query FTS5 can answer — "everything except this" has no
  // candidate set — so a search that is only exclusions finds nothing.
  if (tokens.every((token) => token.startsWith("NOT "))) return null;

  return tokens.reduce((query, token) =>
    token.startsWith("NOT ") ? `${query} ${token}` : `${query} AND ${token}`,
  );
}

/**
 * Weighted so the obvious answer comes first.
 *
 * Someone typing "lighthouse" usually wants the scene called that, not the twentieth
 * paragraph mentioning one. Column order matches the FTS5 table: document_id (never
 * matched), title, synopsis, body, notes.
 */
const WEIGHTS = "0.0, 10.0, 4.0, 1.0, 0.5";

export async function search(
  db: Reader,
  projectId: string,
  input: string,
  { includeTrashed = false, limit = 50 }: SearchOptions = {},
): Promise<SearchHit[]> {
  const query = toFtsQuery(input);
  if (query === null) return [];

  const documents = await db.query<{
    id: string;
    title: string;
    snippet: string;
    trashed: number;
  }>(
    `SELECT b.id,
            b.title,
            snippet(document_fts, 3, '', '', '…', 12) AS snippet,
            CASE WHEN trash.id IS NULL THEN 0 ELSE 1 END AS trashed
       FROM document_fts
       JOIN document d ON d.id = document_fts.document_id
       JOIN binder_item b ON b.id = d.id
       LEFT JOIN binder_item trash
              ON trash.id = b.parent_id AND trash.type = 'trash'
      WHERE document_fts MATCH ?
        AND b.project_id = ?
        AND b.deleted_at IS NULL
        AND (? = 1 OR trash.id IS NULL)
      ORDER BY bm25(document_fts, ${WEIGHTS})
      LIMIT ?`,
    [query, projectId, includeTrashed ? 1 : 0, limit],
  );

  // Folders have titles worth finding, and no document row to be indexed in. A LIKE
  // over titles is enough: there are few of them and no body text to rank.
  const like = `%${input.trim().replace(/[%_]/g, "")}%`;
  const folders = await db.query<{ id: string; title: string; trashed: number }>(
    `SELECT b.id, b.title, CASE WHEN trash.id IS NULL THEN 0 ELSE 1 END AS trashed
       FROM binder_item b
       LEFT JOIN binder_item trash
              ON trash.id = b.parent_id AND trash.type = 'trash'
      WHERE b.project_id = ?
        AND b.type = 'folder'
        AND b.deleted_at IS NULL
        AND b.title LIKE ? ESCAPE '\\'
        AND (? = 1 OR trash.id IS NULL)
      ORDER BY b.title COLLATE NOCASE
      LIMIT ?`,
    [projectId, like, includeTrashed ? 1 : 0, limit],
  );

  return [
    ...folders.map((row) => ({
      id: row.id,
      title: row.title,
      type: "folder" as const,
      snippet: "",
      trashed: row.trashed === 1,
    })),
    ...documents.map((row) => ({
      id: row.id,
      title: row.title,
      type: "document" as const,
      snippet: row.snippet,
      trashed: row.trashed === 1,
    })),
  ];
}
