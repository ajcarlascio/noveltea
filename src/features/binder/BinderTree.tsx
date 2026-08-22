import { useCallback, useMemo, useRef, type KeyboardEvent } from "react";
import type { BinderNode } from "@/data/binder";
import { ChevronIcon, DocumentIcon, FolderIcon } from "./icons";
import "./BinderTree.css";

/**
 * The binder, as an ARIA tree.
 *
 * Deliberately navigation and selection only — no buttons inside the rows. A
 * treeitem with focusable children breaks the pattern screen readers expect, and
 * the arrow keys stop being predictable. Actions live in the toolbar and operate on
 * the selection.
 *
 * Focus is a roving tabindex: exactly one row is tabbable, so Tab moves past the
 * whole binder in one press rather than through every chapter of a novel.
 */

export interface BinderTreeProps {
  nodes: readonly BinderNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  emptyMessage: string;
  label: string;
}

interface Row {
  node: BinderNode;
  level: number;
  parentId: string | null;
}

/** The rows a reader can actually see, in the order they appear. */
function visibleRows(
  nodes: readonly BinderNode[],
  expandedIds: ReadonlySet<string>,
  level = 1,
  parentId: string | null = null,
): Row[] {
  return nodes.flatMap((node) => [
    { node, level, parentId },
    ...(expandedIds.has(node.id)
      ? visibleRows(node.children, expandedIds, level + 1, node.id)
      : []),
  ]);
}

export function BinderTree({
  nodes,
  selectedId,
  onSelect,
  expandedIds,
  onToggle,
  emptyMessage,
  label,
}: BinderTreeProps) {
  const treeRef = useRef<HTMLUListElement>(null);
  const rows = useMemo(() => visibleRows(nodes, expandedIds), [nodes, expandedIds]);

  // The row that owns the tab stop. Selection usually, but the tree must stay
  // reachable before anything is selected, so it falls back to the first row.
  const activeId = rows.some((row) => row.node.id === selectedId)
    ? selectedId
    : (rows[0]?.node.id ?? null);

  const focusRow = useCallback((id: string) => {
    treeRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)?.focus();
  }, []);

  const move = useCallback(
    (id: string, delta: number) => {
      const index = rows.findIndex((row) => row.node.id === id);
      const next = rows[index + delta];
      if (!next) return;
      onSelect(next.node.id);
      focusRow(next.node.id);
    },
    [rows, onSelect, focusRow],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: Row) => {
    const { node } = row;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.id);

    switch (event.key) {
      case "ArrowDown":
        move(node.id, 1);
        break;
      case "ArrowUp":
        move(node.id, -1);
        break;
      case "ArrowRight":
        if (hasChildren && !isExpanded) onToggle(node.id);
        else if (hasChildren) move(node.id, 1);
        else return;
        break;
      case "ArrowLeft":
        if (hasChildren && isExpanded) {
          onToggle(node.id);
        } else if (row.parentId !== null) {
          onSelect(row.parentId);
          focusRow(row.parentId);
        } else {
          return;
        }
        break;
      case "Home":
        if (rows[0]) {
          onSelect(rows[0].node.id);
          focusRow(rows[0].node.id);
        }
        break;
      case "End": {
        const last = rows[rows.length - 1];
        if (last) {
          onSelect(last.node.id);
          focusRow(last.node.id);
        }
        break;
      }
      case "Enter":
      case " ":
        onSelect(node.id);
        break;
      default:
        return;
    }
    // Only for keys actually handled, so typing elsewhere and page scrolling with
    // an unhandled key both still work.
    event.preventDefault();
    event.stopPropagation();
  };

  if (rows.length === 0) {
    return <p className="binder__empty">{emptyMessage}</p>;
  }

  return (
    <ul className="binder" role="tree" aria-label={label} ref={treeRef}>
      {rows.map((row) => {
        const { node, level } = row;
        const hasChildren = node.children.length > 0;
        return (
          <li
            key={node.id}
            role="treeitem"
            data-item-id={node.id}
            aria-level={level}
            aria-selected={node.id === selectedId}
            {...(hasChildren ? { "aria-expanded": expandedIds.has(node.id) } : {})}
            tabIndex={node.id === activeId ? 0 : -1}
            className="binder__row"
            style={{ paddingLeft: `calc(${level - 1} * var(--space-5))` }}
            onClick={() => onSelect(node.id)}
            onKeyDown={(event) => onKeyDown(event, row)}
          >
            <span
              className="binder__twisty"
              aria-hidden="true"
              onClick={(event) => {
                if (!hasChildren) return;
                // The row's own click selects; the twisty must not also do that.
                event.stopPropagation();
                onToggle(node.id);
              }}
            >
              {hasChildren ? <ChevronIcon open={expandedIds.has(node.id)} /> : null}
            </span>
            <span className="binder__icon" aria-hidden="true">
              {node.type === "folder" ? <FolderIcon /> : <DocumentIcon />}
            </span>
            <span className="binder__title">{node.title}</span>
            {node.conflictOfId !== null && (
              // A conflict copy holds words the server refused to merge. Left
              // unmarked it looks like an ordinary document with an odd name, and an
              // author eventually deletes it without realising what is in it.
              <span className="binder__conflict" title="A conflicting version of another document">
                conflict
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
