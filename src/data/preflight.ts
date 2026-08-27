import type { CompilePlan, ProseMirrorNode } from "@noveltea/compile";
import { countWords, inspect, planCompile } from "@noveltea/compile";
import type { SqlValue } from "@noveltea/client-db";

/**
 * What a compile would actually produce, worked out here before anything is sent.
 *
 * The rule is not reimplemented: `planCompile` is the compile worker's own planner,
 * shared from `@noveltea/compile`. A second implementation would drift, and the way it
 * would drift is by disagreeing with the server about what is in the author's book.
 *
 * Running it locally rather than asking is what makes it a pre-flight at all. A long
 * manuscript is expensive to render, and learning that half a selection was folders
 * after waiting for the render is learning it too late.
 */

/** The read surface this module needs. See [[Reader]] in data/projects. */
interface Reader {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

interface ItemRow {
  id: string;
  title: string;
  type: string;
  parent_id: string | null;
  order_key: string;
  deleted_at: string | null;
  content: string | null;
  synopsis: string | null;
  notes: string | null;
}

/**
 * A CHECK constraint keeps malformed JSON out of the column, so what this really
 * guards is JSON that parses to something other than a document — from a version of
 * the app that stored it differently. Reported as null it reaches planCompile as a
 * document with no text, which is exactly what it is from here: an empty chapter the
 * author is warned about rather than a compile that will not start.
 */
function parseContent(raw: string | null): ProseMirrorNode | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as ProseMirrorNode) : null;
  } catch {
    return null;
  }
}

/**
 * Narrows a plan to a preset's selection.
 *
 * Applied to the finished plan rather than to the rows going into it, because the
 * planner needs the whole binder to work at all: trashing is a reparent, so recognising
 * a discarded chapter means walking down from the trash node, and a pre-filtered list
 * would not contain it. Filtering first would make a trashed scene inside a selection
 * look perfectly live.
 *
 * The word count is recomputed with the compiler's own extraction rather than scaled or
 * carried over. It has to agree with what the export actually produces — a count that
 * disagrees with the compiled manuscript is a bug report the author is right to file.
 *
 * An empty selection is the whole manuscript. That is not a convenience: it is how the
 * compile worker reads `included_binder_items`, which only filters when the list is
 * non-empty, and the two have to mean the same thing.
 */
export function narrowPlan(plan: CompilePlan, includedIds: readonly string[]): CompilePlan {
  if (includedIds.length === 0) return plan;
  const keep = new Set(includedIds);
  const included = plan.included.filter((item) => keep.has(item.id));

  return {
    included,
    // Warnings about items nobody selected are noise; the ones with no item at all —
    // "synopses are never exported" — are about the compile itself and stay.
    warnings: plan.warnings.filter(
      (warning) => warning.itemId === undefined || keep.has(warning.itemId),
    ),
    wordCount: included.reduce(
      (total, item) => total + countWords(inspect(item.content).text),
      0,
    ),
  };
}

/**
 * Plans a compile of the project, optionally limited to a preset's selection.
 *
 * Trashed items are fetched rather than filtered out. Trashing is a reparent, not a
 * `deleted_at` write, so the planner needs the trash node and everything under it in
 * order to recognise a discarded chapter — filtering here would hand it a binder in
 * which the trash does not exist and the chapter looks live.
 */
export async function planProject(
  db: Reader,
  projectId: string,
  includedIds: readonly string[] = [],
): Promise<CompilePlan> {
  const rows = await db.query<ItemRow>(
    `SELECT b.id, b.title, b.type, b.parent_id, b.order_key, b.deleted_at,
            d.content, d.synopsis, d.notes
       FROM binder_item b
       LEFT JOIN document d ON d.id = b.id
      WHERE b.project_id = ?
      ORDER BY b.order_key`,
    [projectId],
  );

  const plan = planCompile(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      parentId: row.parent_id,
      orderKey: row.order_key,
      deletedAt: row.deleted_at,
      content: parseContent(row.content),
      synopsis: row.synopsis,
      notes: row.notes,
    })),
  );

  return narrowPlan(plan, includedIds);
}
