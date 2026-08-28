import type { Reader } from "@/data/projects";

/**
 * The whole binder as one flat, ordered list — the outliner's data.
 *
 * The corkboard reads one level, because a wall of two hundred cards is not a thing
 * anyone can look at. The outliner reads all of it, because the question it answers is
 * about the shape of the whole book: where the pace sags, which chapters are still
 * first-draft, how long act two has got. Those are questions about forty scenes at once.
 *
 * Ordered by a materialised path rather than assembled into a tree and walked, so one
 * query returns the manuscript in reading order with each row's depth already on it.
 */

export interface OutlineRow {
  id: string;
  type: "folder" | "document";
  title: string;
  /** 0 for a top-level item. Only meaningful in manuscript order. */
  depth: number;
  synopsis: string | null;
  /**
   * A document's own words; for a folder, everything beneath it.
   *
   * A folder has no prose of its own, so its own count is always zero — and zero is not
   * the useful number when the question is how long a chapter runs.
   */
  words: number;
  labelId: string | null;
  statusId: string | null;
}

interface OutlineQueryRow {
  id: string;
  type: "folder" | "document";
  title: string;
  depth: number;
  synopsis: string | null;
  word_count: number | null;
  label_id: string | null;
  status_id: string | null;
}

/**
 * Every live item, in manuscript order.
 *
 * The trash needs no exclusion clause here: the walk starts at the top-level items and
 * descends, and a trashed item's parent is the trash node, which is not among them. That
 * is the whole reason to walk down rather than to filter — the same reason
 * [[DISCARDED]] exists for the queries that cannot.
 *
 * `'/'` separates the path segments because it sorts below every character an order key
 * can contain (`0-9A-Za-z`), which is what makes a folder sort immediately before its
 * own children rather than after them.
 */
export async function loadOutline(db: Reader, projectId: string): Promise<OutlineRow[]> {
  const rows = await db.query<OutlineQueryRow>(
    `WITH RECURSIVE tree(id, depth, path) AS (
       SELECT id, 0, order_key FROM binder_item
        WHERE project_id = ? AND parent_id IS NULL AND deleted_at IS NULL
          AND type IN ('folder', 'document')
       UNION ALL
       SELECT b.id, tree.depth + 1, tree.path || '/' || b.order_key
         FROM binder_item b JOIN tree ON b.parent_id = tree.id
        WHERE b.deleted_at IS NULL AND b.type IN ('folder', 'document')
     )
     SELECT b.id, b.type, b.title, tree.depth, b.label_id, b.status_id,
            d.synopsis, d.word_count
       FROM tree
       JOIN binder_item b ON b.id = tree.id
       LEFT JOIN document d ON d.id = b.id
      ORDER BY tree.path`,
    [projectId],
  );

  return withFolderTotals(
    rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      depth: row.depth,
      synopsis: row.synopsis,
      words: row.word_count ?? 0,
      labelId: row.label_id,
      statusId: row.status_id,
    })),
  );
}

/**
 * Gives each folder the words of everything beneath it.
 *
 * One pass, because the list is already in depth-first order: a folder's descendants are
 * exactly the rows that follow it until the depth returns to its own. Doing it here
 * rather than in SQL keeps the query one statement, and this is a linear walk over data
 * already in memory.
 */
export function withFolderTotals(rows: readonly OutlineRow[]): OutlineRow[] {
  const totals = rows.map((row) => row.words);

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.type !== "folder") continue;
    let sum = 0;
    for (let j = i + 1; j < rows.length && rows[j]!.depth > rows[i]!.depth; j += 1) {
      // Only documents, or a nested folder's own subtotal would be counted twice.
      if (rows[j]!.type === "document") sum += rows[j]!.words;
    }
    totals[i] = sum;
  }

  return rows.map((row, index) => ({ ...row, words: totals[index]! }));
}

export type SortColumn = "title" | "label" | "status" | "words";
export type Sort = { column: SortColumn; descending: boolean } | null;

/**
 * Sorts the outline, or leaves it in manuscript order.
 *
 * A sorted outline is deliberately flat. Sorting a tree by word count has no meaning —
 * the rows would have to keep their parents, which is the order the author already has —
 * so a sort answers "which scenes are longest" over the whole book, and the interface
 * drops the indentation to say the hierarchy is not what is being shown.
 *
 * @param name resolves a label or status id to its name, so sorting by status orders by
 *   the word on screen rather than by a uuid.
 */
export function sortOutline(
  rows: readonly OutlineRow[],
  sort: Sort,
  name: (id: string | null) => string,
): OutlineRow[] {
  if (sort === null) return [...rows];

  const key = (row: OutlineRow): string | number => {
    switch (sort.column) {
      case "words":
        return row.words;
      case "label":
        return name(row.labelId).toLowerCase();
      case "status":
        return name(row.statusId).toLowerCase();
      default:
        return row.title.toLowerCase();
    }
  };

  return [...rows].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) return 0;
    const order = left < right ? -1 : 1;
    return sort.descending ? -order : order;
  });
}
