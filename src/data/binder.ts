import type { DatabaseClient } from "@/db/client";
import type { Reader } from "@/data/projects";

/**
 * The binder tree, read from the local replica and assembled here.
 *
 * The database stores a flat list with `parent_id` and a lexicographic `order_key`;
 * this is the only place that turns it into a tree, so nothing else has to agree
 * about what "ordered" or "trashed" mean.
 */

export type BinderItemType = "folder" | "document" | "trash";

export interface BinderItem {
  id: string;
  parentId: string | null;
  type: BinderItemType;
  title: string;
  orderKey: string;
  trashedFromParentId: string | null;
  /**
   * The document this one forked from, when it is a conflict copy.
   *
   * The link is a foreign key and never a title: titles are author-editable and
   * ambiguous the moment two copies exist.
   */
  conflictOfId: string | null;
}

export interface BinderNode extends BinderItem {
  children: BinderNode[];
}

export interface Binder {
  /** Top-level items, trash excluded. */
  roots: BinderNode[];
  /** What is in the trash, if the project has a trash node. */
  trash: BinderNode[];
  trashId: string | null;
}

interface BinderRow {
  id: string;
  parent_id: string | null;
  type: BinderItemType;
  title: string;
  order_key: string;
  trashed_from_parent_id: string | null;
  conflict_of_id: string | null;
}

export async function loadBinder(db: Reader, projectId: string): Promise<Binder> {
  const rows = await db.query<BinderRow>(
    `SELECT id, parent_id, type, title, order_key, trashed_from_parent_id, conflict_of_id
       FROM binder_item
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY order_key, id`,
    [projectId],
  );
  return assemble(rows);
}

/**
 * Builds the tree from flat rows.
 *
 * Exported so it can be tested directly: the ordering and the orphan rule are the
 * parts worth pinning, and they do not need a database to exercise.
 */
export function assemble(rows: readonly BinderRow[]): Binder {
  const nodes = new Map<string, BinderNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      type: row.type,
      title: row.title,
      orderKey: row.order_key,
      trashedFromParentId: row.trashed_from_parent_id,
      conflictOfId: row.conflict_of_id,
      children: [],
    });
  }

  const trashId = rows.find((row) => row.type === "trash")?.id ?? null;
  const roots: BinderNode[] = [];
  const trash: BinderNode[] = [];

  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.type === "trash") continue;

    if (row.parent_id === null) {
      roots.push(node);
      continue;
    }
    if (row.parent_id === trashId) {
      trash.push(node);
      continue;
    }
    const parent = nodes.get(row.parent_id);
    if (parent) {
      parent.children.push(node);
    } else {
      // A parent that is not in the result set: tombstoned, or a row that arrived
      // before its parent did. Showing the item at the root beats not showing it —
      // an author can move it back, but cannot recover what was never drawn.
      roots.push(node);
    }
  }

  // The query orders globally by key, which is not the same as ordering within each
  // sibling group: keys are only comparable between siblings.
  const byKey = (a: BinderNode, b: BinderNode) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0);
  const sortDeep = (list: BinderNode[]) => {
    list.sort(byKey);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);
  sortDeep(trash);

  return { roots, trash, trashId };
}

/** Every node in the tree, depth first, as the reader sees it. */
export function flatten(nodes: readonly BinderNode[]): BinderNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

// -- commands ----------------------------------------------------------------------
// Thin wrappers so components name an intent rather than a worker message.

export const createProject = (db: DatabaseClient, title: string) =>
  db.command("createProject", { title });

export const createFolder = (db: DatabaseClient, projectId: string, parentId: string | null, title: string) =>
  db.command("createBinderItem", { projectId, parentId, type: "folder", title });

export const createDocument = (db: DatabaseClient, projectId: string, parentId: string | null, title: string) =>
  db.command("createBinderItem", { projectId, parentId, type: "document", title });

export const renameItem = (db: DatabaseClient, projectId: string, id: string, title: string) =>
  db.command("renameBinderItem", { projectId, id, title });

export const moveItem = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  parentId: string | null,
  afterId: string | null,
) => db.command("moveBinderItem", { projectId, id, parentId, afterId });

export const trashItem = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("trashBinderItem", { projectId, id });

export const restoreItem = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("restoreBinderItem", { projectId, id });

export const emptyTrash = (db: DatabaseClient, projectId: string) =>
  db.command("emptyTrash", { projectId });
