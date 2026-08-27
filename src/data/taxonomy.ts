import type { DatabaseClient } from "@/db/client";
import type { Reader } from "@/data/projects";

/**
 * The project's labels and statuses, read from the local replica.
 *
 * One read per project rather than a join on every binder and corkboard query. A
 * novel has a handful of labels and a handful of statuses — this is a list an author
 * can hold in their head, which is the whole point of it — so resolving an id to a
 * name happens in memory, and the tree and the cards go on selecting the two id
 * columns and nothing more.
 *
 * A consequence worth stating: an id that resolves to nothing renders as no label at
 * all. That is the correct reading of a term deleted on another device whose
 * tombstone has arrived before the items that wore it.
 */

export type TaxonomyKind = "label" | "status";

export interface TaxonomyTerm {
  id: string;
  kind: TaxonomyKind;
  name: string;
  /** Hex, on labels only. */
  color: string | null;
}

export interface Taxonomy {
  labels: TaxonomyTerm[];
  statuses: TaxonomyTerm[];
  /** Every term by id, whichever kind, for turning an item's two columns into names. */
  byId: ReadonlyMap<string, TaxonomyTerm>;
}

interface TaxonomyRow {
  id: string;
  kind: string;
  name: string;
  color: string | null;
}

export const EMPTY_TAXONOMY: Taxonomy = { labels: [], statuses: [], byId: new Map() };

export async function loadTaxonomy(db: Reader, projectId: string): Promise<Taxonomy> {
  const rows = await db.query<TaxonomyRow>(
    `SELECT id, kind, name, color FROM taxonomy
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY order_key, id`,
    [projectId],
  );
  return assembleTaxonomy(rows);
}

/** Exported for its own test: the split by kind is the part worth pinning. */
export function assembleTaxonomy(rows: readonly TaxonomyRow[]): Taxonomy {
  const labels: TaxonomyTerm[] = [];
  const statuses: TaxonomyTerm[] = [];
  const byId = new Map<string, TaxonomyTerm>();

  for (const row of rows) {
    // The column has a CHECK for exactly these two, so anything else is a row this
    // build does not understand — skipped rather than shown in the wrong list.
    if (row.kind !== "label" && row.kind !== "status") continue;
    const term: TaxonomyTerm = {
      id: row.id,
      kind: row.kind,
      name: row.name,
      color: row.kind === "label" ? row.color : null,
    };
    (term.kind === "label" ? labels : statuses).push(term);
    byId.set(term.id, term);
  }

  return { labels, statuses, byId };
}

/** The term an id names, or null — including when the id names nothing any more. */
export function term(taxonomy: Taxonomy, id: string | null): TaxonomyTerm | null {
  return id === null ? null : (taxonomy.byId.get(id) ?? null);
}

// -- commands ----------------------------------------------------------------------

export const createTerm = (
  db: DatabaseClient,
  projectId: string,
  kind: TaxonomyKind,
  name: string,
  color: string | null,
) => db.command("createTaxonomy", { projectId, kind, name, color });

export const updateTerm = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  name: string,
  color: string | null,
) => db.command("updateTaxonomy", { projectId, id, name, color });

export const deleteTerm = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("deleteTaxonomy", { projectId, id });

/** Omit a field to leave it alone; pass null to clear it. */
export const setItemTerms = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  terms: { labelId?: string | null; statusId?: string | null },
) => db.command("setItemTaxonomy", { projectId, id, ...terms });
