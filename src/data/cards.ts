import type { Reader } from "@/data/projects";
import type { DatabaseClient } from "@/db/client";

/**
 * One level of the binder, read as index cards.
 *
 * The corkboard is the same tree the binder shows, asked a different question: not
 * "what is in this book" but "what happens in these scenes, and in what order". So it
 * reads one level at a time rather than assembling a tree — a wall of cards two
 * hundred deep is not a thing anyone can look at.
 */

export interface IndexCard {
  id: string;
  type: "folder" | "document";
  title: string;
  orderKey: string;
  /** Documents only: a folder has no `document` row to carry one. */
  synopsis: string | null;
  /** Documents only. */
  wordCount: number | null;
  /** Folders only: how many live children, so a folder card says what is behind it. */
  childCount: number | null;
  /** Resolved to names against the project's taxonomy by whoever draws the card. */
  labelId: string | null;
  statusId: string | null;
}

interface CardRow {
  id: string;
  type: "folder" | "document";
  title: string;
  order_key: string;
  synopsis: string | null;
  word_count: number | null;
  child_count: number;
  label_id: string | null;
  status_id: string | null;
}

/**
 * @param parentId null for the top level. The trash node and everything under it is
 *   excluded by the type filter and by the tree shape respectively — a trashed item's
 *   parent is the trash, so it is never a child of anything on a corkboard.
 */
export async function loadCards(
  db: Reader,
  projectId: string,
  parentId: string | null,
): Promise<IndexCard[]> {
  const rows = await db.query<CardRow>(
    // `IS` rather than `=` so one query serves the top level and every folder: in
    // SQLite `IS` is the null-safe comparison, and `parent_id = NULL` matches nothing.
    `SELECT b.id, b.type, b.title, b.order_key, b.label_id, b.status_id,
            d.synopsis, d.word_count,
            (SELECT COUNT(*) FROM binder_item c
              WHERE c.parent_id = b.id AND c.deleted_at IS NULL) AS child_count
       FROM binder_item b
       LEFT JOIN document d ON d.id = b.id
      WHERE b.project_id = ?
        AND b.deleted_at IS NULL
        AND b.type IN ('folder', 'document')
        AND b.parent_id IS ?
      ORDER BY b.order_key, b.id`,
    [projectId, parentId],
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    orderKey: row.order_key,
    synopsis: row.type === "document" ? row.synopsis : null,
    wordCount: row.type === "document" ? row.word_count : null,
    childCount: row.type === "folder" ? row.child_count : null,
    labelId: row.label_id,
    statusId: row.status_id,
  }));
}

/**
 * Where a card lands when it is dropped onto another one.
 *
 * Dropping on a card means "go in front of this one", so the answer is whatever now
 * precedes the target — computed with the dragged card already taken out, or moving a
 * card one place to the right would measure against itself and stay put.
 *
 * Pure, and separate from the component, because it is the only part of a drag anyone
 * gets wrong and the only part worth testing without a mouse.
 */
export function afterIdForDropBefore(
  cards: readonly IndexCard[],
  draggedId: string,
  targetId: string,
): string | null {
  const without = cards.filter((card) => card.id !== draggedId);
  const index = without.findIndex((card) => card.id === targetId);
  if (index <= 0) return null;
  return without[index - 1]?.id ?? null;
}

/** The neighbour a card should follow to move one place earlier, or null for first. */
export function afterIdForMoveEarlier(
  cards: readonly IndexCard[],
  id: string,
): string | null | undefined {
  const index = cards.findIndex((card) => card.id === id);
  // undefined means "nowhere to go": already first, or not here at all. Distinct from
  // null, which means "become the first card".
  if (index <= 0) return undefined;
  return cards[index - 2]?.id ?? null;
}

/** The neighbour a card should follow to move one place later. */
export function afterIdForMoveLater(
  cards: readonly IndexCard[],
  id: string,
): string | undefined {
  const index = cards.findIndex((card) => card.id === id);
  if (index === -1 || index === cards.length - 1) return undefined;
  return cards[index + 1]?.id;
}

export const saveSynopsis = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  synopsis: string | null,
) => db.command("saveSynopsis", { projectId, id, synopsis });
