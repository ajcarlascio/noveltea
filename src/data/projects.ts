import type { SqlValue } from "@noveltea/client-db";

/**
 * The read surface these functions need. Narrower than DatabaseClient on purpose:
 * a test can satisfy it with real SQLite in Node and exercise this SQL against the
 * actual migrated schema, which is the only way a wrong column name gets caught.
 */
export interface Reader {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

/**
 * Reads over the local replica. Every screen reads here, never over HTTP.
 *
 * This module is deliberately the only place project SQL lives; a component that
 * writes its own query is a component that will disagree with this one about what
 * "deleted" means.
 */

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/**
 * A deleted project is hidden but recoverable until it is purged, so `deleted_at`
 * is a filter and never a reason to remove the row locally — the author may still
 * restore it, and the server is the one that decides when it is really gone.
 */
export async function listProjects(db: Reader): Promise<Project[]> {
  const rows = await db.query<ProjectRow>(
    `SELECT id, title, created_at, updated_at
       FROM project
      WHERE deleted_at IS NULL
      ORDER BY title COLLATE NOCASE, id`,
  );
  return rows.map(toProject);
}

export async function listDeletedProjects(db: Reader): Promise<Project[]> {
  const rows = await db.query<ProjectRow>(
    `SELECT id, title, created_at, updated_at
       FROM project
      WHERE deleted_at IS NOT NULL
      ORDER BY title COLLATE NOCASE, id`,
  );
  return rows.map(toProject);
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
