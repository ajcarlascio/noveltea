/**
 * Where the binder left off, per project.
 *
 * Which folders were open and which document was last read. Without these, every
 * reload folds the tree shut and drops the author back at "select a document" —
 * the manuscript they were writing is one click away but no longer on screen.
 *
 * Device-only by design: this is a view preference, not prose. It lives in
 * localStorage rather than the SQLite replica because nothing else reads the
 * replica for it, and it must never sync — two devices forcing their expansion on
 * each other would be the tree arguing with itself.
 *
 * Values are untrusted input like everything else read from storage: ids are only
 * ever compared against ids the binder actually contains, so a stale or edited
 * value selects nothing rather than crashing.
 */

import type { BinderNode } from "@/data/binder";

const EXPANDED_PREFIX = "noveltea.binder.expanded.";
const LAST_DOCUMENT_PREFIX = "noveltea.binder.lastDocument.";

export function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** The ids of the folders that were open, in no particular order. */
export function readExpandedIds(storage: Storage | undefined, projectId: string): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(EXPANDED_PREFIX + projectId);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function writeExpandedIds(
  storage: Storage | undefined,
  projectId: string,
  ids: ReadonlySet<string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(EXPANDED_PREFIX + projectId, JSON.stringify([...ids]));
  } catch {
    // Remembered for this session only. The tree still works; it just forgets.
  }
}

/** The document last opened in this project, or null on first visit. */
export function readLastDocumentId(storage: Storage | undefined, projectId: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(LAST_DOCUMENT_PREFIX + projectId);
  } catch {
    return null;
  }
}

export function writeLastDocumentId(
  storage: Storage | undefined,
  projectId: string,
  documentId: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(LAST_DOCUMENT_PREFIX + projectId, documentId);
  } catch {
    // Honoured for this session; not persisted.
  }
}

/**
 * The folder ids on the path from a root down to a node, not including the node
 * itself. Empty when the node is not in the tree — a stale id from storage must
 * expand nothing, not crash the walk.
 */
export function ancestorIds(roots: readonly BinderNode[], id: string): string[] {
  const path: string[] = [];
  const walk = (nodes: readonly BinderNode[]): boolean => {
    for (const node of nodes) {
      if (node.id === id) return true;
      if (walk(node.children)) {
        path.push(node.id);
        return true;
      }
    }
    return false;
  };
  walk(roots);
  // The walk finds the path from the node upward; callers want root first.
  return path.reverse();
}
